const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { uniqueSession } = require('./sessionManager');
require('dotenv').config();

const app = express();
const PORT = 5001;


// Custom middleware to capture raw body AND parse JSON for signature validation
app.use('/action', express.raw({type: 'application/json'}), (req, res, next) => {
  // Store the raw body for signature validation
  req.rawBody = req.body.toString('utf8');
  
  // Parse the JSON manually and attach it to req.body
  try {
    req.body = JSON.parse(req.rawBody);
  } catch (error) {
    console.error('JSON parsing error:', error);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  
  next();
});

// Use bodyParser.json() for non-action routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/action')) {
    return bodyParser.json()(req, res, next);
  }
  next();
});

// ---------------------------------------------------------------------------
// 0)  Helpers
// ---------------------------------------------------------------------------
const ZITADEL_DOMAIN = process.env.ZITADEL_DOMAIN;   // e.g. "auth.example.com"
const accessToken  = process.env.ACCESS_TOKEN;   // PAT or service-user access-token

/**
 * Validates Zitadel webhook signature
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} signingKey - The signing key for this specific endpoint
 * @returns {boolean} - Returns true if validation passes, sends error response and returns false if validation fails
 */
function validateZitadelSignature(req, res, signingKey) {
  // Get the webhook signature
  const signatureHeader = req.headers['zitadel-signature'];
  if (!signatureHeader) {
    console.error("Missing signature");
    res.status(400).send('Missing signature');
    return false;
  }

  // Validate the webhook signature
  const elements = signatureHeader.split(',');
  const timestampElement = elements.find(e => e.startsWith('t='));
  const signatureElement = elements.find(e => e.startsWith('v1='));
  
  if (!timestampElement || !signatureElement) {
    console.error("Invalid signature format");
    res.status(400).send('Invalid signature format');
    return false;
  }
  
  const timestamp = timestampElement.split('=')[1];
  const signature = signatureElement.split('=')[1];
  const signedPayload = `${timestamp}.${req.rawBody}`;
  const hmac = crypto.createHmac('sha256', signingKey)
    .update(signedPayload)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(hmac),
    Buffer.from(signature)
  );

  if (!isValid) {
    console.error("Invalid signature");
    res.status(400).send('Invalid signature');
    return false;
  }

  console.log("Signature validation successful");
  return true;
}

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

function redactToken(s, keep = 8) {
  if (!s) return s;
  const head = s.slice(0, keep);
  return `${head}...<redacted>`;
}

// ---------------------------------------------------------------------------
// 1) Complement token – preuserinfo  (sync restCall)
// ---------------------------------------------------------------------------
app.post('/action/preuserinfo', (req, res) => {
  // Validate signature first
  const PREUSERINFO_SIGNING_KEY = process.env.PREUSERINFO_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, PREUSERINFO_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

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
  // Validate signature first
  const INTERNAL_POST_AUTH_SIGNING_KEY = process.env.INTERNAL_POST_AUTH_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, INTERNAL_POST_AUTH_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

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
  // Validate signature first
  const EXTERNAL_POST_AUTH_SIGNING_KEY = process.env.EXTERNAL_POST_AUTH_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, EXTERNAL_POST_AUTH_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

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

  console.log('Ending external post-auth flow: ', JSON.stringify(resp, null, 2));
  res.json(resp);
});


app.post('/action/uniqueSession', async (req, res) => {
  // Validate signature first
  const UNIQUE_SESSION_SIGNING_KEY = process.env.UNIQUE_SESSION_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, UNIQUE_SESSION_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

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


app.post('/action/testClaims', async (req, res) => {
  // Validate signature first
  const TEST_SIGNING_KEY = process.env.TEST_CLAIMS_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, TEST_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

  let claims = {
    append_claims: [
      {
        key: "companyId",
        value: "COMPANY123"
      },
      {
        key: "personId",
        value: "PERSON123"
      },
      {
        key: "userId",
        value: "USER123"
      }  
    ]
  };
  let response = {
  set_user_metadata: [
    {
      key: "action_metadata_key",
      value: "YWN0aW9uIG1ldGFkYXRhIHZhbHVl"
    }
  ],
  append_claims: [
      {
        key: "companyId",
        value: "COMPANY123"
      },
      {
        key: "personId",
        value: "PERSON123"
      },
      {
        key: "userId",
        value: "USER123"
      }  
    ],
  append_log_claims: [
    "Log to be appended to the log claim on the token"
  ]
  };
  let error = {
    "forwardedStatusCode": 403,
    "forwardedErrorMessage": "You are not authorized to access this application."
  };

  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  //res.json(claims);
  res.json(error);
}); 


app.post('/action/test', async (req, res) => {
  // Validate signature first
  const TEST_SIGNING_KEY = process.env.TEST_SIGNING_KEY;
  if (!validateZitadelSignature(req, res, TEST_SIGNING_KEY)) {
    return; // Response already sent by validation function
  }

  console.log('=== TEST ACTION ===');
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

// ---------------------------------------------------------------------------
// 4) JWT IdP flow – start auth (sync restCall)
// ---------------------------------------------------------------------------
app.get('/auth/start', (req, res) => {
  const zitadelDomain = process.env.ZITADEL_DOMAIN || 'matias-auth-bkeog4.us1.zitadel.cloud';
  const headerName = (process.env.ZITADEL_IDP_HEADER_NAME || 'Authorization').toLowerCase();
  const idToken = process.env.ID_TOKEN;

  console.log('--- JWT IdP flow: incoming redirect from ZITADEL ---');
  console.log('originalUrl:', req.originalUrl);
  console.log('query keys:', Object.keys(req.query));
  console.log('authRequestID present?', 'authRequestID' in req.query);
  console.log('userAgentID present?', 'userAgentID' in req.query);
  console.log('userAgentID length:', (req.query.userAgentID || '').length);

  const { authRequestID, userAgentID } = req.query;
  if (!authRequestID || !userAgentID) {
    return res.status(400).send('Missing authRequestID or userAgentID');
  }
  if (!idToken) {
    console.error('Missing ID_TOKEN env var');
    return res.status(500).send('Server misconfiguration: missing ID_TOKEN');
  }

  // Build the exact upstream URL we’ll POST to from the browser
  const upstream = `https://${zitadelDomain}/idps/jwt?authRequestID=${encodeURIComponent(
    String(authRequestID)
  )}&userAgentID=${encodeURIComponent(String(userAgentID))}`;

  const headerValue =
    headerName === 'authorization' ? `Bearer ${idToken}` : idToken;

  console.log('--- Browser will POST to ZITADEL /idps/jwt ---');
  console.log('upstream URL:', upstream);
  console.log('header name:', headerName);
  console.log('header value (redacted):', redactToken(headerValue));

  // Serve a minimal HTML page that performs the POST from the *browser*
  // so the ZITADEL cookies (user-agent context) are included.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Signing in…</title>
  <!-- Allow cross-origin fetch to your ZITADEL domain -->
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; connect-src https://${zitadelDomain};">
  <meta name="referrer" content="no-referrer" />
</head>
<body>
  <p>Signing you in…</p>
  <script>
    (async () => {
      const upstream = ${JSON.stringify(upstream)};
      const headerName = ${JSON.stringify(headerName)};
      const headerValue = ${JSON.stringify(headerValue)};

      try {
        // Do not use credentials:'omit' — we need browser cookies.
        const r = await fetch(upstream, {
          method: 'POST',
          headers: { [headerName]: headerValue },
          redirect: 'follow',
          credentials: 'include'
        });

        // If ZITADEL redirected, fetch() will usually follow and expose the final URL.
        if (r.redirected) {
          window.location.replace(r.url);
          return;
        }

        // If not redirected, try to use the final URL anyway.
        if (r.url) {
          window.location.replace(r.url);
          return;
        }

        // Fallback: show response text (useful for debugging)
        const text = await r.text();
        document.body.innerText = text || 'Finished, but no redirect detected.';
      } catch (e) {
        document.body.innerText = 'Error contacting ZITADEL: ' + (e && e.message ? e.message : e);
      }
    })();
  </script>
</body>
</html>`);
});

// --- Mock "Legacy" directory (replace with real calls later) ---
const LEGACY_DB = {
  "non-existing@matis-team.us1.zitadel.cloud": {
    userId: "db-163840776835432345",
    username: "non-existing",
    givenName: "Legacy",
    familyName: "User",
    displayName: "Legacy User",
    preferredLanguage: "en",
    email: "non-existing@gmail.com",
    password: "Password1!"
  }
};

// --- Helpers ---
async function zFetch(path, init = {}) {
  const res = await fetch(`https://${ZITADEL_DOMAIN}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Zitadel API ${path} failed: ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

async function createUserFromLegacy(legacy) {
  const body = {
    organizationID: process.env.ZITADEL_ORG_ID,
    username: legacy.username,
    human: {
      profile: {
      givenName: legacy.givenName,
      familyName: legacy.familyName,
      displayName: legacy.displayName,
      preferredLanguage: legacy.preferredLanguage || "en"
      },
    email: {
      email: legacy.email,
      isVerified: true
      }
    }
  };
  const resp = await zFetch('/v2/users/new', { method: 'POST', body: JSON.stringify(body) });
  return resp.userId;
}

async function setUserPassword(userId, password) {
  const body = { human: { password: { password, changeRequired: false } } };
  await zFetch(`/v2/users/${userId}`, { method: 'POST', body: JSON.stringify(body) });
}

// --- Response Action: ListUsers ---
app.post('/action/list-users', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('list-users action, request body:', JSON.stringify(body, null, 2));
    const resp = body.response || {};
    const total = Number((resp.details && resp.details.totalResult) || 0);
    console.log('list-users action, totalResult:', total);
    if (total > 0) return res.json(resp);

    const q = (((body.request || {}).queries || [])[0] || {}).loginNameQuery;
    const loginName = q && q.loginName ? String(q.loginName) : null;
    console.log('list-users action, loginName query:', loginName);

    if (!loginName || !LEGACY_DB[loginName]) {
      console.log('No legacy user found for loginName:', loginName);
      return res.json(resp);
    }

    const userId = await createUserFromLegacy(LEGACY_DB[loginName]);
    console.log('Created new user in Zitadel with userId:', userId);
    const userObj = await zFetch(`/v2/users/${userId}`, { method: 'GET' });
    console.log('Fetched user object:', userObj);

    const manipulated = {
      details: {
        totalResult: "1",
        timestamp: new Date().toISOString()
      },
      result: [
        {
          userId: userObj.userId,
          details: userObj.details,
          state: userObj.state || "USER_STATE_ACTIVE",
          username: userObj.username,
          loginNames: userObj.loginNames || [loginName],
          preferredLoginName: userObj.preferredLoginName || loginName,
          human: userObj.human
        }
      ]
    };

    console.log('Returning manipulated list-users response:', JSON.stringify(manipulated, null, 2));
    return res.json(manipulated);
  } catch (e) {
    console.error('list-users action error:', e);
    return res.status(200).json(req.body?.response || {});
  }
});

// --- Response Action: SetSession ---
app.post('/action/set-session', async (req, res) => {
  try {
    const { request, response } = req.body || {};
    const pw = request?.checks?.password?.password;
    if (!pw) return res.json(response || {});

    const legacyLoginName = Object.keys(LEGACY_DB)[0];
    const legacy = LEGACY_DB[legacyLoginName];

    if (pw !== legacy.password) {
      return res.status(400).json({
        error: { message: 'invalid_credentials' }
      });
    }

    const search = await zFetch('/v2/users', {
      method: 'POST',
      body: JSON.stringify({
        queries: [
          { loginNameQuery: { loginName: legacyLoginName, method: "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE" } }
        ],
        query: { limit: 1 }
      })
    });

    const userId = search?.result?.[0]?.userId;
    if (userId) {
      await setUserPassword(userId, pw);
      await zFetch(`/v2/users/${userId}/metadata`, {
        method: 'PUT',
        body: JSON.stringify({
          metadata: [{ key: "migratedFromLegacy", value: Buffer.from("true").toString("base64") }]
        })
      });
    }

    return res.json(response || {});
  } catch (e) {
    console.error('set-session action error:', e);
    return res.status(200).json(req.body?.response || {});
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
