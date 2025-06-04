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
  console.log('Headers:', req.headers);
  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  console.log('=====================================');
  
  // Return a success response to Zitadel
  res.status(200).json({ status: 'Password reset action processed successfully' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
