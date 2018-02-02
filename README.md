This project uses [Claudia.js](https://claudiajs.com) to deploy to AWS API Gateway & Lambda.

### Environment Config settings

##### API Gateway Stages
* dev
* prod

**stage variables**  
lambdaVersion - stage name  
stripe_secret_api_key  
firebase_database_url  

##### Firebase private key config
Download from
* Firebase console
  * Project settings
    * Service Accounts
      * GENERATE NEW PRIVATE KEY

to  
config/firebaseAccountConfig-<*env_name*>.json  
*(make sure to add to .gitignore)*  
