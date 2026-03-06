const fs = require('fs');

let content = fs.readFileSync('src/services/authService.js', 'utf8');

content = content.replace(
  "if (data.user && data.user.id === userId) {",
  "if (data.user && Number(data.user.id) === Number(userId)) {"
);

fs.writeFileSync('src/services/authService.js', content, 'utf8');
