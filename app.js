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
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);
  let existingRegistration;

  //TODO validate inputs

  const isEarlyDeposit = request.body.paymentType != 'REGISTRATION';

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(eventRef, eventRegRef, request))
  .then((registration) => {
    existingRegistration = registration;
    return createCharge(stripe, request);
  })
  .then((charge) => Promise.all([
    saveChargeData(eventRegRef, charge),
    isEarlyDeposit ? recordEarlyDeposit(eventRegRef, charge, existingRegistration) :
      recordRegistrationPayment(eventRegRef, charge, existingRegistration)
  ]))
  .then(([_ignore, payment]) => payment)
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
  console.log("GET /importedProfile: ", request.queryString);
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

  let serverInfo = {
    timestamp: new Date().getTime()
  };

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
              resolve(serverInfo);
            });
          });
        } else {
          console.log("headObject error", err);
          resolve(serverInfo);
        }
      } else {
        resolve(serverInfo);
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

function fetchRef(ref) {
  return new Promise((resolve, reject) => {
    ref.once('value').then(snapshot => {
      resolve(snapshot.val());
    })
    .catch(err => {
      reject(err);
    });
  });
}

function validateRegistrationState(eventRef, eventRegRef, request) {
  console.log("validating registration state is valid for charge request");
  return Promise.all([fetchRef(eventRef), fetchRef(eventRegRef)])
  .then(([eventInfo, registration]) => {
    console.log("validateRegistrationState: eventInfo", eventInfo);
    console.log("validateRegistrationState: registration", registration);
    console.log("validateRegistrationState: request", request);
    registration = registration || {};
    return new Promise((resolve, reject) => {
      if (request.body.paymentType === 'REGISTRATION') {
        const balance = calculateBalance(eventInfo, registration);
        let order = Object.assign({}, registration.order, registration.cart);
        if (!order.acceptedTerms) {
          console.log("terms and conditions not accepted");
          reject(createUserError(generalServerErrorMessage));
        } else if (getAmountInCents(request) > balance) {
          console.log("charge amount exceeds registration account balance");
          reject(createUserError(generalServerErrorMessage));
        } else if (getAmountInCents(request) < balance &&
            getAmountInCents(request) < eventInfo.priceList.minimumPayment) {
          console.log("charge amount below minimum payment amount");
          reject(createUserError(generalServerErrorMessage));
        }
      } else {
        if (!!registration.earlyDeposit && registration.earlyDeposit.status === 'paid') {
          console.log("early deposit payment already recorded for this registration");
          reject(createUserError(generalServerErrorMessage));
        }
        if (getAmountInCents(request) !== 3600) {
          console.log("invalid early deposit payment amount: " + getAmountInCents(request));
          reject(createUserError(generalServerErrorMessage));
        }
      }
      resolve(registration);
    });
  });
}

function createCharge(stripe, request) {
  console.log("sending charge request to stripe");
  return new Promise((resolve, reject) => {
    stripe.charges.create({
      amount: getAmountInCents(request),
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

function recordEarlyDeposit(eventRegRef, charge, registration) {
  console.log("updating registration for early deposit in firebase");
  let values = {
    ['earlyDeposit/status']: 'paid',
    ['earlyDeposit/charge']: charge.id,
    ['earlyDeposit/updated_at']: firebaseAdmin.database.ServerValue.TIMESTAMP
  }
  if (!registration.created_at) {
    values.created_at = firebaseAdmin.database.ServerValue.TIMESTAMP;
  }
  return new Promise((resolve, reject) => {
    eventRegRef.update(values, err => {
      if (err) {
        console.log("received error from firebase", err);
        reject(createUserError(generalServerErrorMessage));
      } else {
        console.log("successful update request to firebase");
        resolve(values);
      }
    });
  });
}

function recordRegistrationPayment(eventRegRef, charge, registration) {
  console.log("recording registration payment in firebase");
  return Promise.all([
    new Promise((resolve, reject) => {      //add payment object
      let payment = {
        ['status']: 'paid',
        ['charge']: charge.id,
        ['amount']: charge.amount,
        ['created_at']: firebaseAdmin.database.ServerValue.TIMESTAMP
      };
      eventRegRef.child('account').child('payments').push(payment, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful write request to firebase");
          resolve(payment);
        }
      });
    }),
    new Promise((resolve, reject) => {      //update order
      let order = Object.assign({}, registration.order, registration.cart);
      if (!order.created_at) {
        order.created_at = firebaseAdmin.database.ServerValue.TIMESTAMP;
      }
      let values = {
        order,
        cart: null
      };
      if (!registration.created_at) {
        values.created_at = firebaseAdmin.database.ServerValue.TIMESTAMP;
      }
      eventRegRef.update(values, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful update request to firebase");
          //replace created_at with actual server time
          let payment = Object.assign({}, values, {created_at: new Date().getTime()});
          resolve(payment);
        }
      });
    })
  ]).then(([payment, _ignore]) => payment);
}

function getAmountInCents(request) {
  let amountInCents = request.body.amountInCents;
  if (!amountInCents && !!request.body.amount) {
    amountInCents = request.body.amount * 100;
  }
  return amountInCents;
}

function isEarlyDiscountAvailable(event, orderTime) {
  return moment(orderTime).isSameOrBefore(event.earlyDiscount.endDate);
}

function calculateBalance(eventInfo, registration) {
  let order = Object.assign({}, registration.order, registration.cart);

  //main registration
  let totalCharges = 0;
  let totalCredits = 0;
  totalCharges += eventInfo.priceList.roomChoice[order.roomChoice];
  if (isEarlyDiscountAvailable(eventInfo, order.created_at)) {
    totalCharges -= eventInfo.priceList.roomChoice[order.roomChoice] * eventInfo.earlyDiscount.amount;
  }
  if (order.singleSupplement) {
    totalCharges += eventInfo.priceList.singleRoom[order.roomChoice];
  }
  if (order.refrigerator) {
    totalCharges += eventInfo.priceList.refrigerator;
  }
  if (order.thursdayNight) {
    totalCharges += eventInfo.priceList.thursdayNight;
  }
  if (order.donation) {
    totalCharges += order.donation;
  }

  //early deposit credit
  if (registration.earlyDeposit && registration.earlyDeposit.status === 'paid') {
    totalCredits += 3600;
  }

  //previous payments
  let account = registration.account;
  if (!!account && !!account.payments) {
    Object.keys(account.payments)
      .map(k => account.payments[k])
      .filter(p => p.status === 'paid')
      .forEach(p => {
        totalCredits += p.amount;
      });
  }

  return totalCharges - totalCredits;
}
