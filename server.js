const express = require('express');
const bodyParser = require('body-parser');
const { uniqueSession } = require('./sessionManager');
require('dotenv').config();

const app = express();
const PORT = 5001;

app.use(bodyParser.json());

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
    const zitadelUrl = 'https://matias-auth-bkeog4.us1.zitadel.cloud/ipds/jwt';
    
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
