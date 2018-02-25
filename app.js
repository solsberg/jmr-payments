const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin'),
      requestApi = require('request');

const api = new ApiBuilder();
module.exports = api;
let initializedVersion;

const generalServerErrorMessage = "There was a problem with the payment processor. " +
  "Please contact registration@menschwork.org for help.";

api.post("/charge", (request) => {
  console.log("POST /charge: ", request.body);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  initFirebase(request);

  const db = firebaseAdmin.database();
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);
  let existingRegistration = false;

  //TODO validate inputs

  return authenticateRequest(request)
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
    to: request.body.to || DEFAULT_TO_ADDRESS,
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

function initFirebase(request) {
  if (!initializedVersion || initializedVersion != request.env.lambdaVersion) {
    const firebaseServiceAccount = require(`config/firebaseAccountConfig-${request.env.lambdaVersion}.json`);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(firebaseServiceAccount),
      databaseURL: request.env.firebase_database_url
    });
    initializedVersion = request.env.lambdaVersion;
  }
}

function createUserError(userMessage, expected) {
  return {
    userMessage,
    expected
  };
}

function authenticateRequest(request) {
  console.log("verifying id token with firebase");
  return firebaseAdmin.auth().verifyIdToken(request.body.idToken)
  .then(decodedToken => {
    return new Promise((resolve, reject) => {
      if (decodedToken.uid != request.body.userid) {
        console.log("userid in request does not match id token");
        reject(createUserError(generalServerErrorMessage));
      } else {
        resolve();
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
