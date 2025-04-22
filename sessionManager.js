require('dotenv').config();

// This is a ZITADEL action that keeps only the latest session for a user.
async function uniqueSession(userId) {
  console.log('ENTERED uniqueSession ACTION');

  try {
    await keepLatestSessionOnly(userId, 'uniqueSession');
  } catch (error) {
    console.log(`uniqueSession Action error:`, error);
  }

  console.log('FINISHED uniqueSession ACTION');
  return;
}

// This function retrieves an access token using the client credentials grant type.
async function getAccessToken() {
  const response = await fetch(`https://${process.env.ZITADEL_DOMAIN}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}&scope=openid%20urn:zitadel:iam:org:project:id:zitadel:aud`,
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}


async function keepLatestSessionOnly(userId, actionName) {
  const accessToken = process.env.ACCESS_TOKEN;

  const listResp = await fetch(`https://${process.env.ZITADEL_DOMAIN}/v2/sessions/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      queries: [
        {
          userIdQuery: {
            id: userId,
          },
        },
      ],
      sortingColumn: 'CREATION_DATE',
      asc: false,
    }),
  });

  if (!listResp.ok) {
    const errorBody = await listResp.text();
    throw new Error(`${actionName}: Failed to list sessions: ${listResp.status}, ${errorBody}`);
  }

  const sessions = await listResp.json() || [];
  console.log(sessions);
  if (sessions.sessions.length <= 1) {
    console.log(`${actionName}: Only one session active, nothing to delete.`);
    return;
  }

  const latest = sessions.sessions[0];
  const toDelete = sessions.sessions.slice(1);

  console.log(`${actionName}: Keeping session ${latest.id}, deleting ${toDelete.length} older sessions.`);

  await Promise.all(toDelete.map(session =>
    fetch(`https://${process.env.ZITADEL_DOMAIN}/v2/sessions/${session.id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  ));
}

module.exports = { uniqueSession };
