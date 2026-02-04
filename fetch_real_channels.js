import fetch from 'node-fetch';
import fs from 'fs';

async function fetchChannels() {
  const url = "http://line.trx-ott.com/player_api.php?username=9bae915e49&password=c89c12897f64&action=get_live_streams";
  try {
    console.log("Fetching provider channels...");
    const response = await fetch(url);
    if (!response.ok) {
      console.error("Failed to fetch:", response.status);
      return;
    }
    const channels = await response.json();
    console.log(`Fetched ${channels.length} channels.`);
    fs.writeFileSync('provider_channels.json', JSON.stringify(channels, null, 2));
    console.log("Saved to provider_channels.json");

  } catch (e) {
    console.error("Error:", e);
  }
}

fetchChannels();
