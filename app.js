const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin'),
      requestApi = require('request'),
      AWS = require('aws-sdk'),
      moment = require('moment');

AWS.config.update({region: 'us-east-1'});

const api = new ApiBuilder();
module.exports = api;
let firebaseAppCache = {};

const generalServerErrorMessage = "There was a problem with the payment processor. " +
  "Please contact registration@menschwork.org for help.";

//CORS
api.corsOrigin((request) => {
  if (request.env.lambdaVersion === 'prod') {
    return 'https://register.menschwork.org';
  } else {
		return '*';
  }
});

api.corsMaxAge(300); // in seconds

//endpoints

api.post("/charge", (request) => {
  console.log("POST /charge: ", request.body);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);
  let existingRegistration = false;

  //TODO validate inputs

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(eventRegRef))
  .then((existing) => {
    existingRegistration = existing;
    return createCharge(stripe, request);
  })
  .then((charge) => Promise.all([
    saveChargeData(eventRegRef, charge),
    recordEarlyDeposit(eventRegRef, charge, !existingRegistration)
  ]))
  .then(() => "OK")
  .catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.post("/adminEmail", (request) => {
  console.log("POST /adminEmail: ", request.body);

  const DEFAULT_FROM_ADDRESS = 'noreply@menschwork.org';
  const DEFAULT_TO_ADDRESS = 'registration@menschwork.org';
  const DEFAULT_SUBJECT = 'Menschwork Registration';

  //TODO validate inputs

  let formData = {
    from: request.body.from || DEFAULT_FROM_ADDRESS,
    to: request.body.to || request.env.admin_to_address || DEFAULT_TO_ADDRESS,
    subject: request.body.subject || DEFAULT_SUBJECT,
    text: request.body.text
  };

  if (request.env.lambdaVersion !== 'prod') {
    formData.subject = '[TEST] ' + formData.subject;
    formData.text = '*** THIS IS SENT FROM THE TEST ENVIRONMENT ***\n\n' + formData.text;
  }

  return new Promise((resolve, reject) => {
    requestApi.post({
      url: request.env.mailgun_base_url + '/messages',
      formData: formData,
      auth: {
        user: 'api',
        pass: request.env.mailgun_api_key
      }
    }, function optionalCallback(err, httpResponse, body) {
      if (err) {
        console.log("Error received from mailgun", err);
        reject(err);
      } else {
        console.log('Email sent successfully');
        resolve();
      }
    });
  });
});

api.get("/importedProfile", (request) => {
  console.log("GET /importedEmail: ", request.body);
  const firebase = initFirebase(request);

  const email = request.queryString.email.toLowerCase();
  if (!email) {
    throw "missing query string parameter: email";
  }

  return authenticateRequest(firebase, request.queryString.idToken)
  .then((uid) => firebase.auth().getUser(uid))
  .then((user) => {
    const importedProfiles = require('data/imported-profiles.json');
    if (user.email.toLowerCase() !== email) {
      throw "email in request is not authenticated";
    }
    return importedProfiles[email] || {};
  });
});

//sends a backup of firebase data to S3 once daily
api.post("/init", (request) => {
  console.log("POST /init");

  const BUCKET_NAME = 'jmr-payments-backup';
  const firebase = initFirebase(request);

  //calculate target key name for current date
  let keyName = moment().format('YYYY-MM-DD');
  if (request.env.lambdaVersion !== 'prod') {
    keyName = "DEV-" + keyName;
  }
  const keyParams = {
    Bucket: BUCKET_NAME,
    Key: keyName
  };

  const s3 = new AWS.S3();

  return new Promise((resolve, reject) => {
    s3.headObject(keyParams, (err, data) => {
      if (err) {
        if (err.code === 'NotFound') {
          //only create if key does not yet exist
          const ref = firebase.database().ref();
          console.log("fetching data");
          ref.once('value')
          .then((snapshot) => {
            const data = snapshot.val();
            const json = JSON.stringify(data);
            console.log("storing data");
            s3.putObject(Object.assign({}, keyParams, {Body: json}), (err) => {
              if (err) {
                console.log("storing data error", err);
              } else {
                console.log("storing data successful");
              }
              resolve();
            });
          });
        } else {
          console.log("headObject error", err);
          resolve();
        }
      } else {
        resolve();
      }
    });
  });
});

function initFirebase(request) {
  let app = firebaseAppCache[request.env.lambdaVersion];
  if (!app)
  {
    const firebaseServiceAccount = require(`config/firebaseAccountConfig-${request.env.lambdaVersion}.json`);
    app = firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(firebaseServiceAccount),
      databaseURL: request.env.firebase_database_url
    }, request.env.lambdaVersion);
    firebaseAppCache[request.env.lambdaVersion] = app;
  }
  return app;
}

function createUserError(userMessage, expected) {
  return {
    userMessage,
    expected
  };
}

function authenticateRequest(firebase, idToken, uid) {
  console.log("verifying id token with firebase");
  return firebase.auth().verifyIdToken(idToken)
  .then(decodedToken => {
    return new Promise((resolve, reject) => {
      if (!!uid && decodedToken.uid !== uid) {
        console.log("userid in request does not match id token");
        reject(createUserError(generalServerErrorMessage));
      } else {
        resolve(decodedToken.uid);
      }
    });
  });
}

function validateRegistrationState(eventRegRef, request) {
  console.log("validating registration state is valid for charge request");
  return eventRegRef.once('value')
  .then((snapshot) => {
    return new Promise((resolve, reject) => {
      if (snapshot.val() && snapshot.val().madeEarlyDeposit) {
        console.log("early deposit payment already recorded for this registration");
        reject(createUserError(generalServerErrorMessage));
      } else {
        resolve(snapshot.val() && !!snapshot.val().created_at);
      }
    });
  });
}

function createCharge(stripe, request) {
  console.log("sending charge request to stripe");
  return new Promise((resolve, reject) => {
    stripe.charges.create({
      amount: request.body.amount * 100,
      currency: "usd",
      source: request.body.token,
      description: request.body.description
    }, function(err, charge) {
      if (err) {
        console.log("received error from stripe", err);
        if (err.type === 'StripeCardError') {
          reject(createUserError("There was a problem charging your card: " + err.message, true));
        } else {
          reject(createUserError(generalServerErrorMessage));
        }
      } else {
        console.log("successful charge request to stripe");
        resolve(charge);
      }
    });
  });
}

function saveChargeData(eventRegRef, charge) {
  console.log("writing charge to firebase");
  return new Promise((resolve, reject) => {
    eventRegRef.child('transactions').push({charge}, err => {
      if (err) {
        console.log("received error from firebase", err);
        reject(createUserError(generalServerErrorMessage));
      } else {
        console.log("successful write request to firebase");
        resolve();
      }
    });
  });
}

function updateRegistration(eventRegRef, values, isNew) {
  console.log("updating registration in firebase");
  if (isNew) {
    values = Object.assign({}, values, {created_at: firebaseAdmin.database.ServerValue.TIMESTAMP});
  }
  return new Promise((resolve, reject) => {
    eventRegRef.update(values, err => {
      if (err) {
        console.log("received error from firebase", err);
        reject(createUserError(generalServerErrorMessage));
      } else {
        console.log("successful update request to firebase");
        resolve();
      }
    });
  });
}

function recordEarlyDeposit(eventRegRef, charge, isNewRegistration) {
  console.log("updating registration for early deposit in firebase");
  values = {
    ['earlyDeposit/status']: 'paid',
    ['earlyDeposit/charge']: charge.id,
    ['earlyDeposit/updated_at']: firebaseAdmin.database.ServerValue.TIMESTAMP
  }
  if (isNewRegistration) {
    values.created_at = firebaseAdmin.database.ServerValue.TIMESTAMP;
  }
  return new Promise((resolve, reject) => {
    eventRegRef.update(values, err => {
      if (err) {
        console.log("received error from firebase", err);
        reject(createUserError(generalServerErrorMessage));
      } else {
        console.log("successful update request to firebase");
        resolve();
      }
    });
  });
}
