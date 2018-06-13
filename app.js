const ApiBuilder = require('claudia-api-builder'),
      stripeApi = require('stripe'),
      firebaseAdmin = require('firebase-admin'),
      requestApi = require('request'),
      AWS = require('aws-sdk'),
      moment = require('moment'),
      fs = require('fs'),
      get = require('lodash/get'),
      has = require('lodash/has');

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
  .then(() => validateRegistrationState(firebase, eventRef, eventRegRef, request))
  .then(({registration}) => {
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

  let initialBalance;
  let currentEventInfo;
  let currentRegistration;
  let currentBambam;

  return authenticateRequest(firebase, request.body.idToken, request.body.userid)
  .then(() => validateRegistrationState(firebase, eventRef, eventRegRef, request))
  .then(({registration, eventInfo, bambam}) => {
    initialBalance = calculateBalance(eventInfo, registration, bambam);
    currentEventInfo = eventInfo;
    currentRegistration = registration;
    currentBambam = bambam;
    return updateOrder(eventRegRef, registration, request.body.values);
  })
  .then((order) => {
    let updatedRegistration = Object.assign({}, currentRegistration, {order: order});
    if (initialBalance >= 0 && calculateBalance(currentEventInfo, updatedRegistration, currentBambam) < 0) {
      return sendAdminEmail({
        subject: "JMR refund due",
        text: "A refund is now due on the account of user " + request.body.userid
      }, request.env);
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

api.get('/bambam', (request) => {
  console.log("GET /bambam: ", request.queryString);
  const firebase = initFirebase(request);

  return authenticateRequest(firebase, request.queryString.idToken, request.queryString.userid)
  .then(() => fetchBambamStatus(firebase, request.queryString.eventid, request.queryString.userid));
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
  .then((uid) => Promise.all([
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
        let discount_amount;
        let discount_text_suffix = '';
        const combined_discount_amount = Math.round((eventInfo.bambamDiscount.amount + eventInfo.earlyDiscount.amount) * 100);
        const bambam_discount_amount = Math.round(eventInfo.bambamDiscount.amount * 100);
        if (moment().isAfter(moment(eventInfo.earlyDiscount.endDate).endOf('day'))) {
          discount_text = bambam_discount_amount;
        } else {
          discount_amount = combined_discount_amount;
          if (last_discount_date.isAfter(moment(eventInfo.earlyDiscount.endDate).endOf('day'))) {
            discount_text_suffix = ` (through ${moment(eventInfo.earlyDiscount.endDate).format('MMMM D')}, ` +
              `${bambam_discount_amount}% after that)`;
          }
        }
        emailPromises.push(sendTemplateEmail("bambam_invite", {
          to: email,
          subject: `Your friend, ${inviter_fullname}, invites you to the Jewish Men's Retreat`,
          substitutions: [
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

function validateRegistrationState(firebase, eventRef, eventRegRef, request) {
  console.log("validating registration state is valid for charge request");
  return Promise.all([
    fetchRef(eventRef),
    fetchRef(eventRegRef),
    fetchBambamStatus(firebase, eventRef.key, eventRegRef.key)
  ]).then(([eventInfo, registration, bambam]) => {
    console.log("validateRegistrationState: eventInfo", eventInfo);
    console.log("validateRegistrationState: registration", registration);
    console.log("validateRegistrationState: request", request);
    registration = registration || {};
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
        const balance = calculateBalance(eventInfo, registration, bambam);
        console.log("balance", balance);
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
      resolve({registration, eventInfo, bambam});
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

function isEarlyDiscountAvailable(event, orderTime) {
  return moment(orderTime).isSameOrBefore(event.earlyDiscount.endDate);
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

function calculateBalance(eventInfo, registration, bambam) {
  let order = Object.assign({}, registration.order, registration.cart);

  //main registration
  let totalCharges = 0;
  let totalCredits = 0;
  totalCharges += eventInfo.priceList.roomChoice[order.roomChoice];
  if (isEarlyDiscountAvailable(eventInfo, order.created_at)) {
    totalCharges -= eventInfo.priceList.roomChoice[order.roomChoice] * eventInfo.earlyDiscount.amount;
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

function fetchBambamStatus(firebase, eventid, userid) {
  const db = firebase.database();
  const eventRegRef = db.ref(`event-registrations/${eventid}`);
  const usersRef = db.ref('users');

  return Promise.all([
    fetchRef(eventRegRef),
    fetchRef(usersRef)
  ]).then(([registrations, users]) => {
    //find my registration
    let myRegistration = registrations[userid];
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
  });
}
