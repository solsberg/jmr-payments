const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin');

const api = new ApiBuilder();
module.exports = api;
let initializedVersion;

const generalServerErrorMessage = "There was a problem with the payment processor. " +
  "Please contact registration@menschwork.org for help.";

api.post("/charge", (request) => {
  console.log("POST /charge: ", request.body);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  if (!initializedVersion || initializedVersion != request.env.lambdaVersion) {
    const firebaseServiceAccount = require(`config/firebaseAccountConfig-${request.env.lambdaVersion}.json`);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(firebaseServiceAccount),
      databaseURL: request.env.firebase_database_url
    });
    initializedVersion = request.env.lambdaVersion;
  }
  const db = firebaseAdmin.database();
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);

  //TODO validate inputs

  return authenticateRequest(request)
  .then(() => validateRegistrationState(eventRegRef))
  .then(() => createCharge(stripe, request))
  .then((charge) => Promise.all([
    saveChargeData(eventRegRef, charge),
    updateRegistration(eventRegRef, {madeEarlyDeposit: true})
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
        resolve();
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

function updateRegistration(eventRegRef, values) {
  console.log("updating registration in firebase");
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
