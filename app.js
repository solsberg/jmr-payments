const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin');

const api = new ApiBuilder();
module.exports = api;
let initializedVersion;

const generalServerErrorMessage = "There was a problem with the payment processor. " +
  "Please contact registration@menschwork.org for help.";

api.post("/charge", (request) => {
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  if (!initializedVersion || initializedVersion != request.env.lambdaVersion) {
    const firebaseServiceAccount = require(`config/firebaseAccountConfig-${request.env.lambdaVersion}.json`);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(firebaseServiceAccount),
      databaseURL: 'https://jmr-register.firebaseio.com'
    });
    initializedVersion = request.env.lambdaVersion;
  }
  const db = firebaseAdmin.database();
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);

  //TODO validate inputs
  //validate firebase user token
  //fetch event registration statement
  //validate charge
  //  - if early deposit, check not already made
  //post charge to stripe
  //on success, insert payment in firebase
  //return response

  console.log("verifying id token with firebase", request.body.idToken);
  return firebaseAdmin.auth().verifyIdToken(request.body.idToken)
  .then(decodedToken => {
    console.log("received decodedToken:", decodedToken);
    return new Promise((resolve, reject) => {
      if (decodedToken.uid != request.body.userid) {
        console.log("userid in request does not match id token");
        reject(generalServerErrorMessage);
        return;
      }
      console.log("sending charge request to stripe");
      stripe.charges.create({
        amount: request.body.amount * 100,
        currency: "usd",
        source: request.body.token,
        description: request.body.description
      }, function(err, charge) {
        if (err) {
          console.log("received error from stripe", err);
          if (err.type === 'StripeCardError') {
            reject("There was a problem charging your card: " + err.message);
          } else {
            reject(generalServerErrorMessage);
          }
        } else {
          console.log("successful charge request to stripe");
          resolve(charge);
        }
      });
    });
  }).then((charge) => {
    return new Promise((resolve, reject) => {
      console.log("writing charge to firebase");
      eventRegRef.child('transactions').push({charge}, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(generalServerErrorMessage);
        } else {
          console.log("successful write request to firebase");
          resolve();
        }
      });
    });
  }).then(() => {
    return new Promise((resolve, reject) => {
      console.log("updating registration status in firebase");
      eventRegRef.update({madeEarlyDeposit: true}, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(generalServerErrorMessage);
        } else {
          console.log("successful update request to firebase");
          resolve();
        }
      });
    });
  }).then(() => {
    return "OK";
  }).catch(err => {
    console.log(err);
    throw err;
  });
});
