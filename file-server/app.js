const finalhandler = require('finalhandler');
const fs = require('fs');
const http = require('http');
const path = require('path');
const serveStatic = require('serve-static');

const port = process.env.PORT || 8080;
const root = path.join(__dirname, 'build');
const indexPath = path.join(root, 'index.html');

// Serve the merged build/ folder; fallthrough lets us add SPA fallback.
const serve = serveStatic(root, {
  index: false,
  fallthrough: true,
  setHeaders: setHeaders,
});

// Support .headersJson sidecar files emitted by the client webpack builds.
function setHeaders(res, filePath) {
  try {
    const configFile = fs.readFileSync(filePath + '.headersJson');
    const headers = JSON.parse(configFile);
    const headerNames = Object.keys(headers);
    if (headerNames && headerNames.length) {
      res.setHeader('Pragma', null);
      headerNames.forEach((name) => {
        res.setHeader(name, headers[name]);
      });
    }
  } catch (e) {
    // No .headersJson for this file — ignore.
  }
}

const fileServer = http.createServer(function onRequest(req, res) {
  serve(req, res, function onFallthrough(err) {
    if (err) {
      return finalhandler(req, res)(err);
    }
    // SPA fallback: extension-less GET paths (e.g. /home, /{zinvite},
    // anything proxied by the API's catch-all) get the participation
    // index.html instead of a 404.
    const urlPath = (req.url || '').split('?')[0];
    if (req.method === 'GET' && !path.extname(urlPath)) {
      fs.createReadStream(indexPath)
        .on('error', function () {
          finalhandler(req, res)(null);
        })
        .pipe(res);
    } else {
      finalhandler(req, res)(null);
    }
  });
});

fileServer.listen(port, function (err) {
  if (err) {
    console.error('Error starting polisFileServer.');
    console.error(err);
  } else {
    console.log('polisFileServer listening on port ' + port);
  }
});
