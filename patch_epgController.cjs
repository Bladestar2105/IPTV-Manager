const fs = require('fs');

const file = 'src/controllers/epgController.js';
let content = fs.readFileSync(file, 'utf-8');

const importStatement = "import { updateEpgSource, updateProviderEpg, deleteEpgSourceData, loadAllEpgChannels, clearEpgData } from '../services/epgService.js';";
content = content.replace("import { updateEpgSource, updateProviderEpg, deleteEpgSourceData, loadAllEpgChannels } from '../services/epgService.js';", importStatement);

const newCode = `

export const clearEpg = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

    clearEpgData();
    clearChannelsCache(req.user.id);

    res.json({success: true, message: 'EPG data cleared successfully.'});
  } catch (e) {
    console.error('Clear EPG error:', e);
    res.status(500).json({error: e.message});
  }
};
`;

content += newCode;

fs.writeFileSync(file, content, 'utf-8');
console.log('patched epgController.js');
