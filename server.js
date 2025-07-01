const express = require('express');
const bodyParser = require('body-parser');
const { uniqueSession } = require('./sessionManager');

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
  res.status(200).json({ status: 'JWT IdP flow started' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
