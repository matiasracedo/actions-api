const express = require('express');
const bodyParser = require('body-parser');
const { uniqueSession } = require('./sessionManager');
require('dotenv').config();

const app = express();
const PORT = 5001;

app.use(bodyParser.json());

// ---------------------------------------------------------------------------
// 0)  Helpers
// ---------------------------------------------------------------------------
const ZITADEL_DOMAIN = process.env.ZITADEL_DOMAIN;   // e.g. "auth.example.com"
const accessToken  = process.env.ACCESS_TOKEN;   // PAT or service-user access-token

/**
 * Write one or many metadata entries for a user in a single call.
 *
 * @param {string} userId
 * @param {Record<string,string>|Array<{key:string,value:string}>} meta
 */
async function setUserMetadata(userId, meta) {
  // Accept either an object {k:v, …} or an array [{key,k,value:v} …]
  const metadataArr = Array.isArray(meta)
    ? meta.map(({ key, value }) => ({ key, value: Buffer.from(value).toString('base64') }))
    : Object.entries(meta).map(([k, v]) => ({ key: k, value: Buffer.from(v).toString('base64') }));

  console.log(`Setting metadata for user ${userId}:`, metadataArr);
  const resp = await fetch(
    `https://${ZITADEL_DOMAIN}/management/v1/users/${encodeURIComponent(userId)}/metadata/_bulk`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({ metadata: metadataArr }),
    },
  );

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`setUserMetadata failed: ${resp.status} – ${txt}`);
  }
}

// ---------------------------------------------------------------------------
// 1) Complement token – preuserinfo  (sync restCall)
// ---------------------------------------------------------------------------
app.post('/action/preuserinfo', (req, res) => {
  console.log('Received preuserinfo request:', req.body);
  const { user_metadata = [], org = {} } = req.body;
  const append_claims = [];

  const addIfPrefixed = ({ key, value }) => {
    if (key?.startsWith('okta_')) {
      append_claims.push({ key, value: Buffer.from(value, 'base64').toString('utf8') });
    }
  };

  user_metadata.forEach(addIfPrefixed);
  (org.metadata || []).forEach(addIfPrefixed);

  console.log('Appending claims:', append_claims);
  res.json({
    append_claims
  });
});

// ---------------------------------------------------------------------------
// 2) Internal e-mail/password login –  post auth  (sync restWebhook)
// ---------------------------------------------------------------------------
app.post('/action/internal-post-auth', async (req, res) => {
  console.log('Received internal post-auth request:', req.body);
  try {
    const userId = req.body.aggregateID;
    if (userId) {
      await setUserMetadata(userId, {
        okta_authentication_type: 'EMAIL_PASSWORD',
        okta_groups            : JSON.stringify([]),
      });
      console.log('EMAIL_PASSWORD metadata stored for', userId);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// 3) Okta OIDC – post auth  (sync restCall on RetrieveIdentityProviderIntent)
// ---------------------------------------------------------------------------
app.post('/action/external-post-auth', (req, res) => {
  console.log('Received external post-auth request:', JSON.stringify(req.body, null, 2));
  const ctx  = req.body;
  const resp = ctx?.response;

  if (!resp?.addHumanUser) return res.json(resp || {});

  const addUser = resp.addHumanUser;
  console.log('Received external post-auth request addUser:', JSON.stringify(addUser));
  const extInfo = resp.idpInformation?.rawInformation ?? {};
  console.log('Received external post-auth request extInfo:', extInfo);

  addUser.profile.givenName    = extInfo.given_name      || addUser.profile.givenName;
  addUser.profile.familyName   = extInfo.family_name     || addUser.profile.familyName ;
  addUser.email.email          = extInfo.email           || addUser.email.email;
  addUser.username             = extInfo.email           || addUser.username;
  addUser.email.isVerified     = true;

  addUser.metadata ??= [];
  const pushMeta = (k, v) =>
    addUser.metadata.push({ key: k, value: Buffer.from(v).toString('base64') });

  pushMeta('okta_authentication_type', 'SSO:OKTA:OIDC');
  pushMeta('okta_groups', JSON.stringify(extInfo.groups ?? []));

  console.log('Ending external post-auth flow for user', addUser.username);
  res.json(resp);
});


app.post('/action/uniqueSession', async (req, res) => {

  const { userID } = req.body;

  if (!userID) {
    console.error('Missing userID in payload');
    return res.status(400).json({ error: 'Missing userID in payload' });
  }

  try {
    await uniqueSession(userID);
    res.status(200).json({ status: 'Session cleanup complete' });
  } catch (err) {
    console.error('Failed to process uniqueSession:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}); 

app.post('/action/test', async (req, res) => {

    let claims = {
        append_claims: [
          {
            key: "custom_claim",
            value: "Added from Action v2"
          }
        ]
      };
    console.log('Received request:', req.body);
    res.status(200).json(claims);
  }); 

app.post('/action/postPasswordReset', async (req, res) => {
  console.log('=== POST PASSWORD RESET ACTION ===');
  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  console.log('=====================================');
  
  // For restCall target type, we need to return the request object back
  // Extract the request from the payload and return it (unchanged in this case)
  const { response } = req.body;
  
  if (!response) {
    console.error('No response object found in payload');
    return res.status(400).json({ error: 'No response object found in payload' });
  }
  
  // Return the response object back to Zitadel (unchanged for logging purposes)
  res.status(200).json(response);
});

app.get('/auth/start', async (req, res) => {
  console.log('JWT IdP flow started');
  console.log('Request Query:', JSON.stringify(req.query, null, 2));  
  console.log('Request Headers:', JSON.stringify(req.headers, null, 2));

  const idToken = process.env.ID_TOKEN;

  try {
    // Forward the request to Zitadel's JWT IdP endpoint
    const zitadelUrl = 'https://matias-auth-bkeog4.us1.zitadel.cloud/idps/jwt';
    
    // Create URL with query parameters
    const url = new URL(zitadelUrl);
    Object.keys(req.query).forEach(key => {
      url.searchParams.append(key, req.query[key]);
    });
    
    console.log('Forwarding to Zitadel URL:', url.toString());
    
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'x-custom-tkn': `${idToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Zitadel response status:', response.status);
    
    if (response.ok) {
      // If Zitadel responds with a redirect or success, forward the response
      const responseData = await response.text();
      console.log('Zitadel response:', responseData);
      
      // Check if it's a redirect response
      if (response.headers.get('location')) {
        res.redirect(response.headers.get('location'));
      } else {
        res.status(response.status).send(responseData);
      }
    } else {
      console.error('Zitadel error response:', await response.text());
      res.status(500).json({ error: 'Failed to authenticate with Zitadel' });
    }
    
  } catch (error) {
    console.error('Error forwarding to Zitadel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
