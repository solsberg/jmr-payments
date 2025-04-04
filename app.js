const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin'),
      requestApi = require('request'),
      AWS = require('aws-sdk'),
      moment = require('moment'),
      fs = require('fs'),
      get = require('lodash/get'),
      has = require('lodash/has'),
      crypto = require('crypto');

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
  const userRef = db.ref(`users/${request.body.userid}`);
  let existingRegistration;
  let currentEventInfo;
  let currentPromotions;

  //TODO validate inputs

  const isEarlyDeposit = request.body.paymentType != 'REGISTRATION';

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(firebase, eventRef, eventRegRef, userRef, request))
  .then(({registration, eventInfo, promotions}) => {
    existingRegistration = registration;
    currentEventInfo = eventInfo;
    currentPromotions = promotions;
    return createCharge(stripe, request);
  })
  .then((charge) => {
    let promises = [
      saveChargeData(eventRegRef, charge)
    ];
    if (isEarlyDeposit) {
      promises.push(recordEarlyDeposit(eventRegRef, charge, existingRegistration));
    } else {
      promises.push(recordRegistrationPayment_old(eventRegRef, charge, null, existingRegistration, currentPromotions));
      if (!get(existingRegistration, "order.created_at")) {
        promises.push(registerInMailchimp(firebase, request.body.userid, currentEventInfo, request.env));
      }
    }
    return Promise.all(promises);
  })
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
  return sendAdminEmail(request.body, request.env);
});

api.post("/templateEmail", (request) => {
  console.log("POST /templateEmail: ", request.body);

  return sendTemplateEmail(request.body.template, request.body, request.env);
});

function sendTemplateEmail(template, params, env) {
  const DEFAULT_FROM_ADDRESS = 'noreply@menschwork.org';
  const DEFAULT_TO_ADDRESS = 'registration@menschwork.org';
  const DEFAULT_SUBJECT = 'Menschwork Registration';

  //TODO validate inputs

  let formData = {
    from: params.from || DEFAULT_FROM_ADDRESS,
    to: params.to || env.admin_to_address || DEFAULT_TO_ADDRESS,
    subject: params.subject || DEFAULT_SUBJECT
  };

  return new Promise((resolve, reject) => {
    Promise.all([
      new Promise((resolve, reject) => {
        fs.readFile('templates/' + template + '.txt', 'utf8', function(err, contents) {
          if (err) {
            reject(err);
          } else {
            resolve(contents);
          }
        });
      }),
      new Promise((resolve, reject) => {
        fs.readFile('templates/' + template + '.html', 'utf8', function(err, contents) {
          if (err) {
            resolve();  //ignore errors
          } else {
            resolve(contents);
          }
        });
      })
    ])
    .then(([textContent, htmlContent]) => {
      let substitutions = params.substitutions || [];
      formData.text = substitutions
        .reduce((acc, sub) => acc.replace(new RegExp(sub.pattern, 'g'), sub.value), textContent);
      if (!!htmlContent) {
        formData.html = substitutions
          .reduce((acc, sub) => acc.replace(new RegExp(sub.pattern, 'g'), sub.value), htmlContent);
      }
      if (env.lambdaVersion !== 'prod') {
        formData.subject = '[TEST] ' + formData.subject;
        formData.text = '*** THIS IS SENT FROM THE TEST ENVIRONMENT ***\n\n' + formData.text;
      }
      requestApi.post({
        url: env.mailgun_base_url + '/messages',
        formData: formData,
        auth: {
          user: 'api',
          pass: env.mailgun_api_key
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
    })
    .catch(err => {
      reject(err);
    });
  });
}

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

api.post("/updateOrder", (request) => {
  console.log("POST /updateOrder: ", request.body);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);
  const userRef = db.ref(`users/${request.body.userid}`);

  let initialBalance;
  let currentEventInfo;
  let currentRegistration;
  let currentPromotions;
  let currentUser;

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(firebase, eventRef, eventRegRef, userRef, request))
  .then(({registration, eventInfo, promotions, user}) => {
    initialBalance = calculateBalance(eventInfo, registration, user, promotions);
    currentEventInfo = eventInfo;
    currentRegistration = registration;
    currentPromotions = promotions;
    currentUser = user;
    return updateOrder(eventRegRef, registration, request.body.values);
  })
  .then((order) => {
    let updatedRegistration = Object.assign({}, currentRegistration, {order: order});
    if (initialBalance >= 0 && calculateBalance(currentEventInfo, updatedRegistration, currentUser, currentPromotions) < 0) {
      const userRef = db.ref('users').child(request.body.userid);
      return fetchRef(userRef)
      .then(user => sendAdminEmail({
          subject: "JMR refund due",
          text: `A refund is now due on the account of ${user.profile.first_name} ${user.profile.last_name} (${user.email})`
        }, request.env));
    } else {
      return Promise.resolve();
    }
  })
  .then(() => "OK")
  .catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.get('/promotions', (request) => {
  console.log("GET /promotions: ", request.queryString);
  const firebase = initFirebase(request);

  return authenticateRequest(firebase, request.queryString.idToken, request.queryString.userid)
  .then(() => fetchPromotionsStatus(firebase, request.queryString.eventid, request.queryString.userid));
});

api.get('/bambam', (request) => {
  console.log("GET /bambam: ", request.queryString);
  const firebase = initFirebase(request);

  return authenticateRequest(firebase, request.queryString.idToken, request.queryString.userid)
  .then(() => fetchPromotionsStatus(firebase, request.queryString.eventid, request.queryString.userid))
  .then(({bambam}) => bambam);
});

api.get('/roomUpgrade', (request) => {
  console.log("GET /roomUpgrade: ", request.queryString);
  const firebase = initFirebase(request);

  return fetchRoomUpgradeStatus(firebase, request.queryString.eventid);
});

api.post('/bambam', (request) => {
  console.log("POST /bambam: ", request.body);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}`);
  const invitesReg = eventRegRef.child(request.body.userid).child('bambam_invites');
  const usersRef = db.ref(`users`);
  const eventRef = db.ref(`events/${request.body.eventid}`);

  let responseMessages = [];

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => Promise.all([
    fetchRef(eventRegRef),
    fetchRef(usersRef),
    fetchRef(eventRef)
  ])).then(([registrations, users, eventInfo]) => {
    const importedProfiles = require('data/imported-profiles.json');
    const allInviteeEmails = firebaseArrayElements(registrations)
      .reduce((acc, reg) => acc.concat(firebaseArrayElements(reg.bambam_invites || {})), [])
      .map(i => i.email.toLowerCase());
    const alreadyInvited = new Set(allInviteeEmails);
    const alreadyInvitedByMe = new Set(firebaseArrayElements(registrations[request.body.userid].bambam_invites)
      .map(i => i.email.toLowerCase()));
    const alreadyProcessed = new Set();
    const alreadyRegistered = new Set(Object.keys(registrations)
      .filter(uid => has(registrations[uid], "order.roomChoice") || has(registrations[uid], "earlyDeposit"))
      .map(uid => get(users[uid], "email")));
    const thisUser = users[request.body.userid];

    let pushPromises = [];
    let emailPromises = [];

    request.body.emails
    .map(email => email.toLowerCase())
    .forEach(email => {
      //if already invited
      if (alreadyProcessed.has(email)) {
        return;
      } else if (alreadyInvitedByMe.has(email)) {
        responseMessages.push('You have already invited ' + email);
      } else if (alreadyInvited.has(email)) {
        responseMessages.push(email + ' has already been invited by someone else');
      } else if (importedProfiles.hasOwnProperty(email)) {
        responseMessages.push(email + ' has already been to a JMR');
      } else if (alreadyRegistered.has(email)) {
        responseMessages.push(email + ' has already registered');
      } else {
        //push to current reg list
        pushPromises.push(invitesReg.push({
          email,
          invited_at: new Date().getTime()
        }));

        //send email
        const inviter_fullname = `${thisUser.profile.first_name} ${thisUser.profile.last_name}`;
        const last_discount_date = moment()
          .add(eventInfo.bambamDiscount.registerByAmount, eventInfo.bambamDiscount.registerByUnit);
        let discount_amount = Math.round(eventInfo.bambamDiscount.amount * 100);
        let discount_text_suffix;
        let earlyDiscount = getEarlyDiscount(eventInfo);
        if (!!earlyDiscount) {
          if (earlyDiscount.amount > 1) {
            discount_text_suffix = `plus ${formatMoney(earlyDiscount.amount, 0)} early registration discount`;
            if (last_discount_date.isAfter(moment(earlyDiscount.endDate).endOf('day'))) {
              discount_text_suffix += ` through ${moment(earlyDiscount.endDate).format('MMMM D')}`;
              if (earlyDiscount.extended) {
                discount_text_suffix += `, ${formatMoney(earlyDiscount.extended.amount, 0)} after that`;
              }
            }
            discount_text_suffix = ` (${discount_text_suffix})`;
          } else {
            discount_amount = Math.round((eventInfo.bambamDiscount.amount + eventInfo.earlyDiscount.amount) * 100);
            if (last_discount_date.isAfter(moment(eventInfo.earlyDiscount.endDate).endOf('day'))) {
              discount_text_suffix = ` (through ${moment(eventInfo.earlyDiscount.endDate).format('MMMM D')}, ` +
                `${bambam_discount_amount}% after that)`;
            }
          }
        }
        emailPromises.push(sendTemplateEmail("bambam_invite", {
          to: email,
          subject: `Your friend, ${inviter_fullname}, invites you to the Jewish Men's Retreat`,
          substitutions: [
            {pattern: "%%event_title%%", value: event_info.title},
            {pattern: "%%event_email%%", value: `${request.body.eventid}.menschwork.org`},
            {pattern: "%%inviter_name%%", value: inviter_fullname},
            {pattern: "%%bambam_discount_last_date%%", value: last_discount_date.format('MMMM D')},
            {pattern: "%%discount_amount%%", value: discount_amount},
            {pattern: "%%discount_text_suffix%%", value: discount_text_suffix}
          ]
        }, request.env));

        //add to already invited list
        alreadyProcessed.add(email);
      }
    });
    return Promise.all(pushPromises.concat(emailPromises));
  }).then(() => {
    return responseMessages.length > 0 ? responseMessages : undefined;
  }).catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.post("/recordExternalPayment", (request) => {
  console.log("POST /recordExternalPayment: ", request.body);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);

  //TODO validate inputs

  return authenticateAdminRequest(firebase, request.body.idToken)
  .then(() => Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef),
    fetchPromotionsStatus(firebase, eventRef.key, eventRegRef.key)
  ])).then(([eventInfo, registration, promotions]) => {
    let charge;
    let credit;
    if (request.body.externalType === 'CREDIT') {
      credit = {
        amount: request.body.amount
      };
    } else {
      charge = {
        id: request.body.externalType,
        amount: request.body.amount
      };
    }
    let timestamp = moment(request.body.paymentDate).valueOf();
    let promises = [
      recordRegistrationPayment_old(eventRegRef, charge, credit, registration, promotions, timestamp)
    ];
    if (!get(registration, "order.created_at")) {
      promises.push(registerInMailchimp(firebase, request.body.userid, eventInfo, request.env));
    }
    return Promise.all(promises);
  })
  .then(([payment]) => payment)
  .catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.post("/cancelRegistration", (request) => {
  console.log("POST /cancelRegistration: ", request.body);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);

  //TODO validate inputs

  return authenticateAdminRequest(firebase, request.body.idToken)
  .then(() => fetchRef(eventRef))
  .then((eventInfo) => {
    return Promise.all([
      new Promise((resolve, reject) => {
        eventRegRef.child('order').update({ cancelled: true }, err => {
          if (err) {
            console.log("received error from firebase", err);
            reject(createUserError(generalServerErrorMessage));
          } else {
            console.log("successful update request to firebase");
            resolve(true);
          }
        });
      }),
      unregisterInMailchimp(firebase, request.body.userid, eventInfo, request.env)
    ]);
  })
  .catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.post("validateCode", (request) => {
  console.log("POST /validateCode: ", request.body);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const codesRef = db.ref(`codes`);
  const userRef = db.ref(`users/${request.body.userid}`);

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => Promise.all([
    fetchRef(eventRef),
    fetchRef(codesRef),
    fetchRef(userRef)
  ])).then(([eventInfo, codes, user]) => validateDiscountCode(request.body.code, eventInfo, user, codes))
  .catch(err => {
    console.log(err);
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });

});

api.post("checkout", (request) => {
  console.log("POST /checkout: ", request.body);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  const firebase = initFirebase(request);

  const db = firebase.database();
  const eventRef = db.ref(`events/${request.body.eventid}`);
  const eventRegRef = db.ref(`event-registrations/${request.body.eventid}/${request.body.userid}`);
  const userRef = db.ref(`users/${request.body.userid}`);


  const origin = request.normalizedHeaders['origin'];

  //TODO validate inputs

  return (request.body.isAdmin ? authenticateAdminRequest : authenticateRequest)(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(firebase, eventRef, eventRegRef, userRef, request, request.body.isAdmin))
  .then(({ registration, user }) => {
    let line_items_info = [{
      product: request.env.jmr_registration_stripe_product_id,
      amount: getAmountInCents(request),
    }];

    let order = Object.assign({}, registration.order, registration.cart);
    if (order.donation) {
      line_items_info[0].amount -= order.donation;
      line_items_info.push({
        product: request.env.menschwork_donation_stripe_product_id,
        amount: order.donation,
      });
    }

    return stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      line_items: line_items_info.map(item => ({
        price_data: {
          currency: 'usd',
          product: item.product,
          unit_amount: item.amount,
        },
        quantity: 1,
      })),
      mode: 'payment',
      customer_email: user.email.toLowerCase(),
      client_reference_id: `${request.body.eventid}:${request.body.userid}`,
      metadata: {
        eventid: request.body.eventid,
        userid: request.body.userid,
        isAdmin: request.body.isAdmin,
        isNewRegistration: request.body.isNewRegistration,
      },
      return_url: `${origin}/callback?session_id={CHECKOUT_SESSION_ID}`,
      redirect_on_completion: 'always',
    });
  })
  .then((session) => {
    return {
      clientSecret: session.client_secret,
    };
  })
  .catch(err => {
    if (err instanceof Object && !(err instanceof Error)) {
      return new api.ApiResponse(err, {'Content-Type': 'application/json'}, err.expected ? 403 : 500);
    }
    throw err;
  });
});

api.post("stripe_payments_webhook", (request) => {
  console.log("POST /stripe_payments_webhook: ", request.body);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  const firebase = initFirebase(request);
  const db = firebase.database();

  const payload = request.rawBody;
  const sig = request.normalizedHeaders['stripe-signature'];

  let event = stripe.webhooks.constructEvent(payload, sig, request.env.stripe_payments_webhook_secret);

  // if (
  //   event.type === 'checkout.session.completed'
  //   || event.type === 'checkout.session.async_payment_succeeded'
  // ) {
  //   fulfillCheckout(event.data.object.id);
  // }
  // console.log("webhook event:", event)

  return fulfillCheckout(event.data.object.id, stripe, firebase).then(() => {
    // Return a response to acknowledge receipt of the event
    return { received: true };
  });
});

function fulfillCheckout(sessionId, stripe, firebase) {
  // TODO: Make this function safe to run multiple times,
  // even concurrently, with the same session ID

  // TODO: Make sure fulfillment hasn't already been
  // peformed for this Checkout Session

  // Retrieve the Checkout Session from the API with line_items expanded
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  })
  .then((checkoutSession) => {
    // fetch event and registration data from firebase
    const db = firebase.database();
    const { eventid, userid } = checkoutSession.metadata;
    const eventRegRef = db.ref(`event-registrations/${eventid}/${userid}`);

    return Promise.all([
      fetchRef(eventRegRef),
      fetchPromotionsStatus(firebase, eventid, userid),
    ]).then(([registration, promotions]) => {
      //discountCode
      const applyDiscountCode = get(registration, "cart.applyDiscountCode");
      if (!!applyDiscountCode && !get(registration, "order.discountCode")) {
        promotions.discountCode = validateDiscountCode(applyDiscountCode, eventInfo, user, codes);
      }

      return recordRegistrationPayment(eventRegRef, checkoutSession, null, registration, promotions);
    });
  });
}

api.get("checkoutSession", (request) => {
  console.log("GET /checkoutSession: ", request.queryString);
  const stripe = stripeApi(request.env.stripe_secret_api_key);
  const firebase = initFirebase(request);

  let currentAuthUser;

  return authenticateRequest(firebase, request.queryString.idToken)
  .then(uid => firebase.auth().getUser(uid))
  .then(user => {
    currentAuthUser = user;
    return stripe.checkout.sessions.retrieve(request.queryString.session_id);
  })
  .then((checkoutSession) => {
    const { eventid, userid, isAdmin, isNewRegistration } = checkoutSession.metadata;

    // validate user auth
    if (currentAuthUser.uid !== userid) {
      if (isAdmin !== 'true' || !currentAuthUser.customClaims.admin) {
        throw createUserError("You are not authorized to view this session");
      }
    }

    return {
      status: checkoutSession.status,
      payment_status: checkoutSession.payment_status,
      eventid,
      userid,
      isAdmin,
      isNewRegistration
    };
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
    if (!!uid && decodedToken.uid !== uid) {
      console.log("userid in request does not match id token");
      throw createUserError(generalServerErrorMessage);
    }
    return decodedToken.uid;
  });
}

function authenticateAdminRequest(firebase, idToken) {
  console.log("verifying id token with firebase");
  return firebase.auth().verifyIdToken(idToken)
  .then(decodedToken => firebase.auth().getUser(decodedToken.uid))
  .then(user => {
    if (user.customClaims.admin) {
      return user.uid;
    } else {
      console.log("userid in request is not an admin");
      throw createUserError(generalServerErrorMessage);
    }
  });
}

function fetchRef(ref) {
  return ref.once('value').then(snapshot => snapshot.val());
}

function fetchUserData(firebase, eventid, userid) {
  console.log("fetching base user registration data");

  const db = firebase.database();
  const eventRef = db.ref(`events/${eventid}`);
  const eventRegRef = db.ref(`event-registrations/${eventid}/${userid}`);

  return Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef)
  ]).then(([event, registration]) => ({event, registration}));
}

function validateRegistrationState(firebase, eventRef, eventRegRef, userRef, request, isAdmin) {
  console.log("validating registration state is valid for charge request");
  const db = firebase.database();
  const codesRef = db.ref('codes');

  return Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef),
    fetchRef(userRef),
    fetchPromotionsStatus(firebase, eventRef.key, eventRegRef.key),
    fetchRef(codesRef)
  ]).then(([eventInfo, registration, user, promotions, codes]) => {
    console.log("validateRegistrationState: eventInfo", eventInfo);
    console.log("validateRegistrationState: registration", registration);
    console.log("validateRegistrationState: request", request);
    registration = registration || {};

    //discountCode
    const applyDiscountCode = get(registration, "cart.applyDiscountCode");
    if (!!applyDiscountCode && !get(registration, "order.discountCode")) {
      promotions.discountCode = validateDiscountCode(applyDiscountCode, eventInfo, user, codes);
    }

    return new Promise((resolve, reject) => {
      if (!request.body.paymentType) {
        //updateOrder request
        if (!registration.order) {
          console.log("no existing order found");
          reject(createUserError(generalServerErrorMessage));
        } else if (!registration.account || !registration.account.payments) {
          console.log("no previous payment found");
          reject(createUserError(generalServerErrorMessage));
        }
      } else if (request.body.paymentType === 'REGISTRATION') {
        const balance = calculateBalance(eventInfo, registration, user, promotions);
        console.log("balance", balance);
        let order = Object.assign({}, registration.order, registration.cart);
        const isWaitlist = !has(order, 'created_at') && eventInfo.status == 'WAITLIST' && !order.allowWaitlist;
        const isNewRegistration = !registration.order;

        let minimumPayment = 0;
        if (isNewRegistration) {
          minimumPayment = eventInfo.priceList.minimumPayment;
          if (isPreRegistered(user, eventInfo)) {
            minimumPayment -= eventInfo.preRegistration.depositAmount;
          }
        }
        if (has(order, 'minimumPayment') && order.minimumPayment < minimumPayment) {
          minimumPayment = order.minimumPayment;
        }
        if (!!order.donation) {
          minimumPayment += order.donation;
        }
        if (moment().isAfter(eventInfo.finalPaymentDate)) {
          minimumPayment = balance;
        }

        if (!isAdmin) {
          if (!order.acceptedTerms) {
            console.log("terms and conditions not accepted");
            reject(createUserError(generalServerErrorMessage));
          } else if (eventInfo.acceptCovidPolicy && !order.acceptedCovidPolicy) {
            console.log("covid policy not accepted");
            reject(createUserError(generalServerErrorMessage));
          } else if (isWaitlist) {
            console.log("user on waitlist without place");
            reject(createUserError(generalServerErrorMessage));
          } else if (getAmountInCents(request) > balance) {
            console.log("charge amount exceeds registration account balance");
            reject(createUserError(generalServerErrorMessage));
          } else if (getAmountInCents(request) < balance &&
              getAmountInCents(request) < minimumPayment) {
            console.log("charge amount below minimum payment amount");
            reject(createUserError(generalServerErrorMessage));
          }
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
      resolve({registration, eventInfo, promotions, user});
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

function recordRegistrationPayment_old(eventRegRef, charge, credit, registration, promotions, timestamp) {
  console.log("recording registration payment in firebase");
  let order = Object.assign({}, registration.order, registration.cart);
  let donation = order.donation;
  let promises = [
    new Promise((resolve, reject) => {      //add payment object
      let collectionRef;
      let transaction;
      if (!!charge) {
        transaction = {
          ['status']: 'paid',
          ['charge']: charge.id,
          ['amount']: charge.amount,
          ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
        };
        collectionRef = eventRegRef.child('account').child('payments');
      } else {
        transaction = {
          ['amount']: credit.amount,
          ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
        };
        collectionRef = eventRegRef.child('account').child('credits');
      }
      collectionRef.push(transaction, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful write request to firebase");
          resolve(transaction);
        }
      });
    }),
    new Promise((resolve, reject) => {      //update order
      let transactionTime = null;
      if (!!credit) {
        transactionTime = get(registration, 'scholarship.created_at');
      }
      transactionTime ||= timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP;

      if (!order.created_at) {
        order.created_at = transactionTime;
      }
      if (get(promotions, 'roomUpgrade.available') || (get(registration, 'roomUpgrade.available') &&
          moment(registration.roomUpgrade.timestamp).add(30, 'minutes').isAfter(moment(timestamp)))) {
        order.roomUpgrade = true;
      }

      //discountCode
      let discountCode = get(promotions, 'discountCode.name');
      if (!!discountCode && !order.discountCode) {
        order.discountCode = discountCode;
      }
      order.applyDiscountCode = null;
      delete order.donation;

      let values = {
        order,
        cart: null
      };
      if (!registration.created_at) {
        values.created_at = transactionTime;
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
  ];
  if (!!donation) {
    promises.push(new Promise((resolve, reject) => {      //add donation object
      let transaction = {
        ['amount']: donation,
        ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
      };
      eventRegRef.child('account').child('donations').push(transaction, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful write request to firebase");
          resolve(transaction);
        }
      });
    }));
  }

  return Promise.all(promises).then(([transaction, _ignore]) => transaction);
}

function recordRegistrationPayment(eventRegRef, checkoutSession, credit, registration, promotions, timestamp) {
  console.log("recording registration payment in firebase");
  let order = Object.assign({}, registration.order, registration.cart);
  let donationToStore = checkoutSession.payment_status === "paid" ? order.donation : null;
  let promises = [
    new Promise((resolve, reject) => {      //add payment object
      let collectionRef;
      let newTransaction;
      let existingTransactionKey;
      let existingTransaction;
      if (!!checkoutSession) {
        const existingTransactions = get(registration, "account.payments", {});
        existingTransactionKey = Object.keys(get(registration, "account.payments", {}))
          .find(k => existingTransactions[k].checkout_session_id === checkoutSession.id);
        if (!existingTransactionKey) {
          newTransaction = {
            ['status']: checkoutSession.payment_status === "paid" ? "paid" : "pending",
            ['checkout_session_id']: checkoutSession.id,
            ['payment_id']: checkoutSession.payment_intent,
            ['amount']: checkoutSession.amount_total,
            ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
          };
          collectionRef = eventRegRef.child('account').child('payments');
        } else {
          existingTransaction = existingTransactions[existingTransactionKey];
        }
      } else {
        newTransaction = {
          ['amount']: credit.amount,
          ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
        };
        collectionRef = eventRegRef.child('account').child('credits');
      }
      if (newTransaction) {
        collectionRef.push(newTransaction, err => {
          if (err) {
            console.log("received error from firebase", err);
            reject(createUserError(generalServerErrorMessage));
          } else {
            console.log("successful write request to firebase");
            resolve(newTransaction);
          }
        });
      } else {
        const values = {
          ['payment_id']: checkoutSession.payment_intent,
          ['status']: checkoutSession.payment_status === "paid" ? "paid" : "pending",
          ['amount']: checkoutSession.amount_total
        };
        eventRegRef.child('account').child('payments').child(existingTransactionKey).update(values, err => {
          if (err) {
            console.log("received error from firebase", err);
            reject(createUserError(generalServerErrorMessage));
          } else {
            console.log("successful update request to firebase");
            //replace created_at with actual server time
            let transaction = Object.assign({}, existingTransaction, values);
            resolve(transaction);
          }
        });
      }
    }),
    new Promise((resolve, reject) => {      //update order
      let transactionTime = null;
      if (!!credit) {
        transactionTime = get(registration, 'scholarship.created_at');
      }
      transactionTime ||= timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP;

      if (!order.created_at) {
        order.created_at = transactionTime;
      }
      if (get(promotions, 'roomUpgrade.available') || (get(registration, 'roomUpgrade.available') &&
          moment(registration.roomUpgrade.timestamp).add(30, 'minutes').isAfter(moment(timestamp)))) {
        order.roomUpgrade = true;
      }

      //discountCode
      let discountCode = get(promotions, 'discountCode.name');
      if (!!discountCode && !order.discountCode) {
        order.discountCode = discountCode;
      }
      order.applyDiscountCode = null;
      if (!!donationToStore) {
        delete order.donation;
      }

      let values = {
        order,
        cart: null
      };
      if (!registration.created_at) {
        values.created_at = transactionTime;
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
  ];
  if (!!donationToStore) {
    promises.push(new Promise((resolve, reject) => {      //add donation object
      let transaction = {
        ['amount']: donationToStore,
        ['created_at']: timestamp || firebaseAdmin.database.ServerValue.TIMESTAMP
      };
      eventRegRef.child('account').child('donations').push(transaction, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful write request to firebase");
          resolve(transaction);
        }
      });
    }));
  }

  return Promise.all(promises).then(([transaction, _ignore]) => transaction);
}

function recordCheckout(eventRegRef, checkoutSession, registration, promotions) {
  console.log("recording checkout session initiation in firebase");
  let order = Object.assign({}, registration.order, registration.cart);
  let promises = [
    new Promise((resolve, reject) => {      //add payment object
      let transaction = {
        ['status']: 'pending',
        ['checkout_session_id']: checkoutSession.id,
        ['payment_id']: checkoutSession.payment_intent,
        ['amount']: checkoutSession.amount_total,
        ['created_at']: firebaseAdmin.database.ServerValue.TIMESTAMP
      };
      eventRegRef.child('account').child('payments').push(transaction, err => {
        if (err) {
          console.log("received error from firebase", err);
          reject(createUserError(generalServerErrorMessage));
        } else {
          console.log("successful write request to firebase");
          resolve(transaction);
        }
      });
    }),
    new Promise((resolve, reject) => {      //update order
      let transactionTime = firebaseAdmin.database.ServerValue.TIMESTAMP;

      if (!order.created_at) {
        order.created_at = transactionTime;
      }
      if (get(promotions, 'roomUpgrade.available') || (get(registration, 'roomUpgrade.available') &&
          moment(registration.roomUpgrade.timestamp).add(30, 'minutes').isAfter(moment(timestamp)))) {
        order.roomUpgrade = true;
      }

      //discountCode
      let discountCode = get(promotions, 'discountCode.name');
      if (!!discountCode && !order.discountCode) {
        order.discountCode = discountCode;
      }
      order.applyDiscountCode = null;

      let values = {
        order,
        cart: null
      };
      if (!registration.created_at) {
        values.created_at = transactionTime;
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
  ];

  return Promise.all(promises).then(() => checkoutSession);
}

function updateOrder(eventRegRef, registration, values) {
  console.log("updating order in firebase");
  let order = Object.assign({}, registration.order, values);
  return eventRegRef.child("order").set(order)
  .then(() => order)
  .catch(err => {
    console.log("received error from firebase", err);
    throw createUserError(generalServerErrorMessage);
  });
}

function getAmountInCents(request) {
  let amountInCents = request.body.amountInCents;
  if (!amountInCents && !!request.body.amount) {
    amountInCents = request.body.amount * 100;
  }
  return amountInCents;
}

function getEarlyDiscount(event, asOf, roomType) {
  if (roomType && get(event, `roomTypes.${roomType}.noEarlyDiscount`)) {
    return null;
  }
  if (has(event, 'earlyDiscount') && moment(asOf).isSameOrBefore(event.earlyDiscount.endDate, 'day')) {
    return event.earlyDiscount;
  }
  if (has(event, 'earlyDiscount.extended') &&
      moment(asOf).isSameOrBefore(event.earlyDiscount.extended.endDate, 'day')) {
    return event.earlyDiscount.extended;
  }
}

function isBambamDiscountAvailable(bambam, event, orderTime) {
  if (!!bambam.inviter) {
    if (moment(orderTime).isSameOrBefore(moment(bambam.inviter.invited_at)
        .add(event.bambamDiscount.registerByAmount, event.bambamDiscount.registerByUnit)
        .endOf('day'))) {
      return true;
    }
  }
  if (!!bambam.invitees && !!bambam.invitees.find(i =>
      i.registered &&
      moment(i.registered_at).isSameOrBefore(moment(i.invited_at)
        .add(event.bambamDiscount.registerByAmount, event.bambamDiscount.registerByUnit)
        .endOf('day')))) {
    return true;
  }
}

function isPreRegistered(user, event, onlyDiscount) {
  if (!user || !has(event, 'preRegistration.users')) {
    return false;
  }
  let entry = Object.keys(event.preRegistration.users)
    .find(k => event.preRegistration.users[k].toLowerCase() === user.email.toLowerCase());
  if (!entry && !onlyDiscount && has(event, 'preRegistration.usersNoDiscount')) {
    entry = Object.keys(event.preRegistration.usersNoDiscount)
      .find(k => event.preRegistration.usersNoDiscount[k].toLowerCase() === user.email.toLowerCase());
  }
  return entry != null;
}

function getPreRegistrationDiscount(user, event, asOf, roomType) {
  if (roomType && get(event, `roomTypes.${roomType}.noEarlyDiscount`)) {
    return null;
  }
  if (isPreRegistered(user, event, true) && has(event, 'preRegistration.discount') &&
      moment(asOf).isSameOrBefore(event.preRegistration.discount.endDate, 'day')) {
    return event.preRegistration.discount;
  }
}

function getAvailableCredit(user, event) {
  if (!user || !has(event, 'availableCredit')) {
    return 0;
  }
  let entry = Object.values(event.availableCredit)
    .find(c => c.email.toLowerCase() === user.email.toLowerCase());
  return !!entry ? entry.amount : 0;
}

function getLateCharge(event, asOf, roomType) {
  if (roomType && get(event, `roomTypes.${roomType}.noLateCharge`)) {
    return null;
  }
  if (has(event, 'priceList.lateCharge') &&
      moment(asOf).isSameOrAfter(event.priceList.lateCharge.startDate, 'day')) {
    return event.priceList.lateCharge;
  }
}

function calculateBalance(eventInfo, registration, user, promotions) {
  let order = Object.assign({}, registration.order, registration.cart);
  let {bambam} = promotions;

  //main registration
  let totalCharges = 0;
  let totalCredits = 0;
  totalCharges += eventInfo.priceList.roomChoice[order.roomChoice];

  //discountCode
  const discountCodeName = order.discountCode || get(promotions, "discountCode.name");
  let discountCode;
  if (!!discountCodeName) {
    let discountCodes = firebaseArrayElements(eventInfo.discountCodes);
    discountCode = discountCodes.find(c => c.name === discountCodeName);
  }
  if (!!discountCode) {
    totalCharges -= discountCode.amount;
  }

  let preRegistrationDiscount = getPreRegistrationDiscount(user, eventInfo, order.created_at || get(registration, 'scholarship.created_at'), order.roomChoice);
  if (!!preRegistrationDiscount && !get(discountCode, 'exclusive') && !order.waiveDiscount) {
    if (!eventInfo.onlineOnly || order.roomChoice == "online_base") {
      if (preRegistrationDiscount.amount > 1) {
        totalCharges -= preRegistrationDiscount.amount;
      } else {
        totalCharges -= eventInfo.priceList.roomChoice[order.roomChoice] * preRegistrationDiscount.amount;
      }
    }
  }

  let earlyDiscount = getEarlyDiscount(eventInfo, order.created_at || get(registration, 'scholarship.created_at'), order.roomChoice);
  if (!!earlyDiscount && !preRegistrationDiscount && !get(discountCode, 'exclusive')) {
    if (!eventInfo.onlineOnly || order.roomChoice == "online_base") {
      if (earlyDiscount.amount > 1) {
        totalCharges -= earlyDiscount.amount;
      } else {
        totalCharges -= eventInfo.priceList.roomChoice[order.roomChoice] * earlyDiscount.amount;
      }
    }
  }
  let lateCharge = getLateCharge(eventInfo, order.created_at, order.roomChoice);
  if (!!lateCharge) {
    if (!eventInfo.onlineOnly || order.roomChoice == "online_base") {
      if (lateCharge.amount > 1) {
        totalCharges += lateCharge.amount;
      } else {
        totalCharges += eventInfo.priceList.roomChoice[order.roomChoice] * lateCharge.amount;
      }
    }
  }
  if (isBambamDiscountAvailable(bambam, eventInfo, order.created_at)) {
    totalCharges -= eventInfo.priceList.roomChoice[order.roomChoice] * eventInfo.bambamDiscount.amount;
  }
  if (order.singleSupplement) {
    totalCharges += eventInfo.priceList.singleRoom[order.roomChoice];
  }
  if (order.refrigerator) {
    totalCharges += eventInfo.priceList.refrigerator;
  }
  if (order.thursdayNight) {
    let thursdayNightRate = eventInfo.priceList.thursdayNight;
    if (order.singleSupplement && has(eventInfo, 'priceList.thursdayNightSingle')) {
      thursdayNightRate = eventInfo.priceList.thursdayNightSingle;
    }
    totalCharges += thursdayNightRate;
  }
  if (order.donation) {
    totalCharges += order.donation;
  }

  //early deposit credit
  if (registration.earlyDeposit && registration.earlyDeposit.status === 'paid') {
    totalCredits += 3600;
  }

  if (isPreRegistered(user, eventInfo)) {
    totalCredits += eventInfo.preRegistration.depositAmount;
  }

  totalCredits += getAvailableCredit(user, eventInfo);

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

  //refunds
  if (!!account && !!account.refunds) {
    Object.keys(account.refunds)
      .map(k => account.refunds[k])
      .forEach(p => {
        totalCredits -= p.amount;
      });
  }

  //credits
  if (!!account && !!account.credits) {
    Object.keys(account.credits)
      .map(k => account.credits[k])
      .forEach(p => {
        totalCredits += p.amount;
      });
  }

  //previous donations
  if (!!account && !!account.donations) {
    Object.keys(account.donations)
      .forEach(p => {
        totalCredits -= p.amount;
      });
  }

  return totalCharges - totalCredits;
}

function formatMoney(amountInCents, scale=2) {
  return '$' + (0.01 * amountInCents).toFixed(scale).replace(/(\d)(?=(\d{3})+\.)/g, '$1,');
}

function sendAdminEmail(values, env) {
  const DEFAULT_FROM_ADDRESS = 'noreply@menschwork.org';
  const DEFAULT_TO_ADDRESS = 'registration@menschwork.org';
  const DEFAULT_SUBJECT = 'Menschwork Registration';

  let formData = {
    from: values.from || DEFAULT_FROM_ADDRESS,
    to: values.to || env.admin_to_address || DEFAULT_TO_ADDRESS,
    subject: values.subject || DEFAULT_SUBJECT,
    text: values.text
  };

  if (env.lambdaVersion !== 'prod') {
    formData.subject = '[TEST] ' + formData.subject;
    formData.text = '*** THIS IS SENT FROM THE TEST ENVIRONMENT ***\n\n' + formData.text;
  }

  return new Promise((resolve, reject) => {
    requestApi.post({
      url: env.mailgun_base_url + '/messages',
      formData: formData,
      auth: {
        user: 'api',
        pass: env.mailgun_api_key
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
}

function firebaseArrayElements(arrayObject) {
  if (!!arrayObject) {
    return Object.keys(arrayObject)
      .map(k => arrayObject[k]);
  } else {
    return [];
  }
}

function fetchRoomUpgradeStatus(firebase, eventid) {
  const db = firebase.database();
  const eventRef = db.ref(`events/${eventid}`);
  const eventRegRef = db.ref(`event-registrations/${eventid}`);

  return Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef)
  ]).then(([eventInfo, registrations]) => calculateRoomUpgrade(eventInfo, registrations || {}));
}

function fetchPromotionsStatus(firebase, eventid, userid) {
  const db = firebase.database();
  const eventRef = db.ref(`events/${eventid}`);
  const eventRegRef = db.ref(`event-registrations/${eventid}`);
  const usersRef = db.ref('users');

  return Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef),
    fetchRef(usersRef)
  ]).then(([eventInfo, registrations, users]) => {
    let promotions = {
      bambam: calculateBambamStatus(eventInfo, registrations || {}, users, userid),
      roomUpgrade: calculateRoomUpgrade(eventInfo, registrations || {}, users, userid)
    };
    let myRegistration = !!registrations && registrations[userid];
    return updatePromotionsStatus(myRegistration, promotions, eventRegRef.child(userid));
  });
}

function updatePromotionsStatus(registration, promotions, eventRegRef) {
  console.log("updating registration with promotions status in firebase");

  //if not yet registered
  if (!isRegistered(registration)) {
    //if room upgrade available
    if (promotions.roomUpgrade.available) {
      return eventRegRef.child("promotions/roomUpgrade").set(promotions.roomUpgrade)
        .then(() => promotions);
    }
    else if (has(registration, "promotions.roomUpgrade")) {
      return eventRegRef.child("promotions/roomUpgrade").remove()
        .then(() => promotions);
    }
  }

  return promotions;
}

function calculateBambamStatus(eventInfo, registrations, users, userid) {
  if (!get(eventInfo, 'bambamDiscount.enabled')) {
    return {};
  }
  //find my registration
  let myRegistration = !!registrations && registrations[userid];
  //find my user
  let myUser = users[userid];
  if (!myUser) {
    throw "missing user record";
  }

  let usersArray = firebaseArrayElements(users);

  //invitees
  const invitees = firebaseArrayElements(get(myRegistration, 'bambam_invites', {}))
    .map(invite => ({
      invite,
      user: usersArray.find(user => user.email.toLowerCase() === invite.email.toLowerCase())
    }))
    .map(i => {
      let registration = i.user && registrations[i.user.uid];
      return {
        email: i.invite.email,
        invited_at: i.invite.invited_at,
        registered: has(registration, "order.roomChoice"),
        registered_at: get(registration, "order.created_at")
      };
    });

  //inviter
  let invites = Object.keys(registrations)
    .reduce((acc, uid) => {
      const registration = registrations[uid];
      const invitees = firebaseArrayElements(get(registration, 'bambam_invites', {}));
      const foundInvite = invitees.find(i => i.email.toLowerCase() === myUser.email.toLowerCase());
      if (!!foundInvite) {
        return acc.concat([{
          uid,
          invite: foundInvite
        }]);
      }
      return acc;
    }, []);
  let inviter;
  if (invites.length > 0) {
    let inviterUser = users[invites[0].uid];
    if (!!inviterUser) {
      inviter = {
        email: inviterUser.email,
        first_name: inviterUser.profile.first_name,
        last_name: inviterUser.profile.last_name,
        invited_at: invites[0].invite.invited_at
      };
    }
  }

  return {
    invitees: invitees.length > 0 ? invitees : undefined,
    inviter
  };
}

function calculateRoomUpgrade(eventInfo, registrations, users, userid) {
  console.log("calculateRoomUpgrade", eventInfo, registrations);
  if (!get(eventInfo, 'roomUpgrade.enabled')) {
    return {};
  }

  //how many orders already made
  const orders = Object.values(registrations)
    .filter(reg => get(reg, "order.roomUpgrade") && ['basic', 'standard'].includes(reg.order.roomChoice));

  // check for user blacklist
  let myUser = !!users && users[userid];
  if (myUser && eventInfo.roomUpgrade.applyBlacklist) {
    const blacklist = require('data/roomUpgrade-blacklist.json');
    if (blacklist.find(email => email.toLowerCase() === myUser.email.toLowerCase())) {
      return {
        available: false
      };
    }
  }
  return {
    available: orders.length < eventInfo.roomUpgrade.firstN,
    timestamp: new Date().getTime()
  };
}

function isRegistered(reg) {
  return has(reg, 'account.payments') ||
    (has(reg, 'account.credits') && has(reg, 'order')) ||
    has(reg, 'external_payment.registration');
}

function registerInMailchimp(firebase, uid, eventInfo, env) {
  const db = firebase.database();
  const userRef = db.ref('users').child(uid);
  let memberHash;

  //fetch user
  return fetchRef(userRef)
  .then(user => {
    //calc memberHash
    memberHash = crypto.createHash('md5').update(user.email.toLowerCase()).digest("hex");

    //try update member
    return new Promise((resolve, reject) => {
      requestApi.patch({
        url: env.mailchimp_list_url + '/members/' + memberHash,
        json: true,
        body: {
          interests: {
            [eventInfo.mailchimpGroupId]: true
          }
        },
        auth: {
          user: 'api',
          pass: env.mailchimp_api_key
        }
      }, function optionalCallback(err, httpResponse, body) {
        console.log("mailchimp update", {err, httpResponse, body});
        if ((err && httpResponse.statusCode == 404) ||
            (!err && get(body, "status", 0) == 404)) {
          resolve({status: 'notfound', user});
        } else if (err) {
          console.log("Error received from mailchimp update member call", err);
        } else {
          console.log('Mailchimp update member successful');
        }
        resolve();
      });
    });
  })
  .then(rslt => {
    if (get(rslt, "status") === 'notfound') {
      let {user} = rslt;
      return new Promise((resolve, reject) => {
        requestApi.post({
          url: env.mailchimp_list_url + '/members?skip_merge_validation=true',
          json: true,
          body: {
            email_address: user.email,
            email_type: 'html',
            status: 'subscribed',
            merge_fields: {
              FNAME: user.profile.first_name,
              LNAME: user.profile.last_name,
              ADDRESS_1: user.profile.address_1,
              ADDRESS_2: user.profile.address_2,
              CITY: user.profile.city,
              STATE: user.profile.state,
              PHONE: user.profile.phone
            },
            interests: {
              [eventInfo.mailchimpGroupId]: true
            }
          },
          auth: {
            user: 'api',
            pass: env.mailchimp_api_key
          }
        }, function optionalCallback(err, httpResponse, body) {
          console.log("mailchimp create", {err, httpResponse, body});
          if (err) {
            console.log("Error received from mailchimp create member call", err);
          } else {
            console.log('Mailchimp create member successful');
          }
          resolve();
        });
      });
    }
  });
}

function unregisterInMailchimp(firebase, uid, eventInfo, env) {
  const db = firebase.database();
  const userRef = db.ref('users').child(uid);
  let memberHash;

  //fetch user
  return fetchRef(userRef)
  .then(user => {
    //calc memberHash
    memberHash = crypto.createHash('md5').update(user.email.toLowerCase()).digest("hex");

    //try update member
    return new Promise((resolve, reject) => {
      requestApi.patch({
        url: env.mailchimp_list_url + '/members/' + memberHash,
        json: true,
        body: {
          interests: {
            [eventInfo.mailchimpGroupId]: false
          }
        },
        auth: {
          user: 'api',
          pass: env.mailchimp_api_key
        }
      }, function optionalCallback(err, httpResponse, body) {
        console.log("mailchimp update", {err, httpResponse, body});
        if ((err && httpResponse.statusCode == 404) ||
            (!err && get(body, "status", 0) == 404)) {
          resolve({status: 'notfound', user});
        } else if (err) {
          console.log("Error received from mailchimp update member call", err);
        } else {
          console.log('Mailchimp update member successful');
        }
        resolve();
      });
    });
  });
}

function isFirstTimer(email) {
  const importedProfiles = require('data/imported-profiles.json');
  return !importedProfiles.hasOwnProperty(email);
}

function validateDiscountCode(code, eventInfo, user, codes) {
  let matchedCode = firebaseArrayElements(eventInfo.discountCodes).find(eventCode => {
    let codeInfo = get(codes, eventCode.name);
    return !!codeInfo && codeInfo.code.toLowerCase() === code.toLowerCase();
  });
  if (!matchedCode || !matchedCode.enabled ||
      (!!matchedCode.startDate && moment().isBefore(matchedCode.startDate))
  ) {
    return {
      valid: false,
      status: "Invalid code."
    };
  } else if (!!matchedCode.endDate && moment().isAfter(moment(matchedCode.endDate).endOf('day'))) {
    return {
      valid: false,
      status: "Code has expired."
    };
  } else if (!!matchedCode.firstTimer && !isFirstTimer(user.email)) {
    return {
      valid: false,
      status: "Code valid only for first-time participants."
    };
  } else {
    return {
      valid: true,
      name: matchedCode.name
    };
  }
}
