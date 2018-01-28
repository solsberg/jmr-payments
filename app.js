const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin');



const api = new ApiBuilder();
module.exports = api;

api.post("/charge", (request) => {
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  const firebaseServiceAccount = require(`config/firebaseAccountConfig-${request.env.lambdaVersion}.json`);
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(firebaseServiceAccount),
    databaseURL: 'https://jmr-register.firebaseio.com'
  });
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
        reject("userid in request does not match id token");
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
          reject(err);
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
          reject(err);
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
          reject(err);
        } else {
          console.log("successful update request to firebase");
          resolve();
        }
      });
    });
  }).then(() => {
    return "ok";
  }).catch(err => {
    console.log(err);
    return "not ok";
  });
});
