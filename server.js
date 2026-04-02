const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
let PORT = process.env.MPT_PORT || 50515;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// ── Printer helpers (macOS / CUPS) ──

function listPrinters() {
  try {
    const output = execSync('lpstat -p 2>/dev/null', { encoding: 'utf-8' });
    const printers = [];
    for (const line of output.split('\n')) {
      const match = line.match(/^printer\s+(\S+)\s/);
      if (match) {
        printers.push({
          Name: match[1],
          IsDefault: false,
          Status: line.includes('idle') ? 'Idle' : 'Ready'
        });
      }
    }
    try {
      const def = execSync('lpstat -d 2>/dev/null', { encoding: 'utf-8' });
      const defMatch = def.match(/:\s*(\S+)/);
      if (defMatch) {
        for (const p of printers) {
          if (p.Name === defMatch[1]) p.IsDefault = true;
        }
      }
    } catch {}
    return printers;
  } catch {
    return [];
  }
}

function printPDF(printerName, base64Data, copies = 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpt-'));
  const tmpFile = path.join(tmpDir, 'document.pdf');
  fs.writeFileSync(tmpFile, Buffer.from(base64Data, 'base64'));

  return new Promise((resolve, reject) => {
    exec(`lpr -P "${printerName}" -# "${copies}" -o sides=one-sided "${tmpFile}"`, (err) => {
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
      if (err) reject(err);
      else resolve();
    });
  });
}

function printTestPage(printerName) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpt-'));
  const tmpFile = path.join(tmpDir, 'testpage.txt');
  fs.writeFileSync(tmpFile, [
    '================================',
    '  Mainchain Printing Tool',
    '  macOS Edition',
    '================================',
    '',
    `  Printer: ${printerName}`,
    `  Date: ${new Date().toLocaleString()}`,
    `  Host: ${os.hostname()}`,
    '',
    '  If you can read this,',
    '  printing is working!',
    '',
    '================================',
  ].join('\n'));

  return new Promise((resolve, reject) => {
    exec(`lpr -P "${printerName}" -o sides=one-sided "${tmpFile}"`, (err) => {
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── State ──

const clientId = uuidv4();
const connections = new Map();
let messageCounter = 0;
const printHistory = [];

// ── SignalR Hub Proxy JS ──
// Freman loads this as a <script> tag to discover hub methods

const hubProxyJS = `
(function ($, window, undefined) {
    "use strict";
    if (!$ || !$.signalR || !$.hubConnection) { return; }
    var signalR = $.signalR;

    function makeProxyCallback(hub, callback) {
        return function () { callback.apply(hub, $.makeArray(arguments)); };
    }

    function registerHubProxies(instance, shouldSubscribe) {
        var key, hub, memberKey, memberValue, subscriptionMethod;
        for (key in instance) {
            if (instance.hasOwnProperty(key)) {
                hub = instance[key];
                if (!(hub.hubName)) { continue; }
                subscriptionMethod = shouldSubscribe ? hub.on : hub.off;
                memberValue = hub.client;
                for (memberKey in memberValue) {
                    if (memberValue.hasOwnProperty(memberKey)) {
                        subscriptionMethod.call(hub, memberKey, makeProxyCallback(hub, memberValue[memberKey]));
                    }
                }
            }
        }
    }

    $.hubConnection.prototype.createHubProxies = function () {
        var proxies = {};
        this.starting(function () {
            registerHubProxies(proxies, true);
            this._registerSubscribedHubs();
        }).disconnected(function () {
            registerHubProxies(proxies, false);
        });

        proxies['mainchainPrintingToolHub'] = this.createHubProxy('mainchainPrintingToolHub');
        proxies['mainchainPrintingToolHub'].client = {};
        proxies['mainchainPrintingToolHub'].server = {
            getCheckRequestData: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["GetCheckRequestData"], $.makeArray(arguments)));
            },
            initiateOrJoinGroup: function (groupId) {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["InitiateOrJoinGroup"], $.makeArray(arguments)));
            },
            request: function (document) {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["REQUEST"], $.makeArray(arguments)));
            },
            requestClientId: function (browserId) {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["REQUESTCLIENTID"], $.makeArray(arguments)));
            },
            requestTestPrint: function (printerName) {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["REQUESTTESTPRINT"], $.makeArray(arguments)));
            },
            send: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["Send"], $.makeArray(arguments)));
            },
            getPrintersInformation: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["GetPrintersInformation"], $.makeArray(arguments)));
            },
            getVersion: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["GetVersion"], $.makeArray(arguments)));
            },
            testPrint: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["TestPrint"], $.makeArray(arguments)));
            },
            print: function () {
                return proxies['mainchainPrintingToolHub'].invoke.apply(proxies['mainchainPrintingToolHub'], $.merge(["Print"], $.makeArray(arguments)));
            }
        };
        return proxies;
    };

    signalR.hub = $.hubConnection("/signalr", { useDefaultPath: false });
    $.extend(signalR, signalR.hub.createHubProxies());
}(window.jQuery, window));
`;

// ── HTTP Endpoints ──

app.get('/signalr/hubs', (req, res) => {
  res.type('application/javascript').send(hubProxyJS);
});

app.get('/signalr/negotiate', (req, res) => {
  const connectionId = uuidv4();
  const connectionToken = Buffer.from(connectionId).toString('base64url');
  res.json({
    Url: '/signalr',
    ConnectionToken: connectionToken,
    ConnectionId: connectionId,
    KeepAliveTimeout: 20.0,
    DisconnectTimeout: 30.0,
    ConnectionTimeout: 110.0,
    TryWebSockets: true,
    ProtocolVersion: '2.0',
    TransportConnectTimeout: 5.0,
    LongPollDelay: 0.0
  });
});

app.post('/signalr/negotiate', (req, res) => {
  const connectionId = uuidv4();
  const connectionToken = Buffer.from(connectionId).toString('base64url');
  res.json({
    Url: '/signalr',
    ConnectionToken: connectionToken,
    ConnectionId: connectionId,
    KeepAliveTimeout: 20.0,
    DisconnectTimeout: 30.0,
    ConnectionTimeout: 110.0,
    TryWebSockets: true,
    ProtocolVersion: '2.0',
    TransportConnectTimeout: 5.0,
    LongPollDelay: 0.0
  });
});

app.get('/signalr/start', (req, res) => {
  res.json({ Response: 'started' });
});

app.get('/signalr/ping', (req, res) => {
  res.json({ Response: 'pong' });
});

app.post('/signalr/abort', (req, res) => {
  res.status(200).end();
});

app.get('/signalr/poll', (req, res) => {
  res.json({ C: String(++messageCounter), M: [] });
});

app.post('/signalr/send', (req, res) => {
  const data = req.body?.data;
  if (data) {
    try {
      const msg = JSON.parse(data);
      const result = handleHubInvocation(msg);
      res.json(result);
      return;
    } catch {}
  }
  res.json({});
});

app.get('/', (req, res) => {
  res.json({
    name: 'Mainchain Printing Tool',
    version: '2.1.1.0',
    platform: 'macOS',
    status: 'running'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    clientId,
    version: '2.1.1.0',
    port: PORT,
    printers: listPrinters(),
    connections: connections.size,
    printHistory: printHistory.slice(-20)
  });
});

app.get('/api/printers', (req, res) => {
  res.json(listPrinters());
});

// ── Hub Method Handler ──

function pushToClients(method, args) {
  const pushMsg = {
    C: String(++messageCounter),
    M: [{ H: 'mainchainPrintingToolHub', M: method, A: args }]
  };
  const payload = JSON.stringify(pushMsg);
  for (const [, conn] of connections) {
    if (conn.ws && conn.ws.readyState === 1) {
      conn.ws.send(payload);
    }
  }
}

function handleHubInvocation(msg) {
  const method = msg.M;
  const args = msg.A || [];
  const invocationId = msg.I;

  let result = null;
  let error = null;

  try {
    switch (method?.toUpperCase()) {
      case 'SEND': {
        result = null;
        const sendArg = args[1];

        if (sendArg && typeof sendArg === 'object' && sendArg.file) {
          // Print request
          const pName = sendArg.printerName;
          const fileName = sendArg.filename || 'document.pdf';
          console.log(`[print] ${fileName} -> ${pName}`);
          const job = { filename: fileName, printer: pName, time: new Date().toISOString(), status: 'sending' };
          printHistory.push(job);
          if (printHistory.length > 50) printHistory.shift();
          printPDF(pName, sendArg.file, 1)
            .then(() => { job.status = 'sent'; console.log(`[print] OK: ${fileName}`); })
            .catch(e => { job.status = 'failed'; console.error(`[print] FAILED: ${fileName}:`, e.message); });
        } else {
          // Handshake — push printer data via addMessage client callback
          const printers = listPrinters();
          const printerNames = printers.map(p => p.Name);
          const addMessageData = JSON.stringify({
            ClientId: clientId,
            Printers: JSON.stringify(printerNames)
          });
          setTimeout(() => pushToClients('addMessage', [addMessageData]), 100);
        }
        break;
      }

      case 'GETPRINTERSINFORMATION': {
        result = listPrinters().map(p => p.Name);
        break;
      }

      case 'GETVERSION':
        result = '2.1.1.0';
        break;

      case 'REQUESTCLIENTID':
        result = {
          ClientId: clientId,
          MacAddress: '00:00:00:00:00:00',
          UserName: os.userInfo().username,
          CustomerName: os.hostname(),
          StandaloneMode: true,
          BrowserID: args[0] || ''
        };
        break;

      case 'REQUESTTESTPRINT': {
        const printers = listPrinters();
        const target = args[0]
          ? printers.find(p => p.Name === args[0])
          : printers.find(p => p.IsDefault) || printers[0];
        if (target) {
          printTestPage(target.Name)
            .then(() => console.log(`[print] test page -> ${target.Name}`))
            .catch(e => console.error(`[print] test page failed:`, e.message));
          result = { Success: true, PrinterName: target.Name };
        } else {
          error = 'No printers found';
        }
        break;
      }

      case 'REQUEST': {
        const doc = args[0];
        if (doc && doc.base64string) {
          const pName = doc.printername || doc.printerName;
          const copies = doc.numberOfCopies || 1;
          const printers = listPrinters();
          const target = pName
            ? printers.find(p => p.Name === pName) || printers[0]
            : printers.find(p => p.IsDefault) || printers[0];
          if (target) {
            printPDF(target.Name, doc.base64string, copies)
              .then(() => console.log(`[print] document -> ${target.Name}`))
              .catch(e => console.error(`[print] failed:`, e.message));
            result = { id: doc.id || uuidv4(), isPrinted: true, message: `Sent to ${target.Name}` };
          } else {
            error = 'No printers available';
          }
        }
        break;
      }

      case 'TESTPRINT': {
        const printers = listPrinters();
        const target = args[0]
          ? printers.find(p => p.Name === args[0]) || printers[0]
          : printers.find(p => p.IsDefault) || printers[0];
        if (target) {
          printTestPage(target.Name);
          result = true;
        } else {
          error = 'No printers found';
        }
        break;
      }

      case 'PRINT': {
        const doc = args[0];
        if (doc && doc.base64string) {
          const pName = doc.printername || doc.printerName;
          const copies = doc.numberOfCopies || 1;
          const printers = listPrinters();
          const target = pName
            ? printers.find(p => p.Name === pName) || printers[0]
            : printers.find(p => p.IsDefault) || printers[0];
          if (target) {
            printPDF(target.Name, doc.base64string, copies);
            result = true;
          }
        }
        break;
      }

      case 'INITIATEORJOINGROUP':
        result = { GroupId: args[0], Success: true };
        break;

      case 'GETCHECKREQUESTDATA': {
        const printers = listPrinters();
        result = {
          ClientId: clientId,
          Printers: printers.map(p => ({ PrinterName: p.Name, IsDefault: p.IsDefault })),
          Version: '2.1.1.0',
          Status: 'Connected'
        };
        break;
      }

      default:
        result = {};
    }
  } catch (e) {
    error = e.message;
    console.error(`[hub] error in ${method}:`, e.message);
  }

  const response = { I: String(invocationId) };
  if (error) {
    response.E = error;
  } else if (result !== undefined) {
    response.R = result;
  }
  return response;
}

// ── WebSocket Server ──

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/signalr/connect') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const token = reqUrl.searchParams.get('connectionToken');
      const connectionId = token
        ? Buffer.from(token, 'base64url').toString()
        : uuidv4();

      connections.set(connectionId, { ws, groups: [] });

      // Legacy SignalR init message
      ws.send(JSON.stringify({ C: String(++messageCounter), S: 1, M: [] }));

      const keepAlive = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send('{}');
      }, 15000);

      ws.on('message', (data) => {
        const raw = data.toString();
        if (!raw || raw === '{}') return;

        try {
          const msg = JSON.parse(raw);
          if (msg.H && msg.M) {
            const response = handleHubInvocation(msg);
            ws.send(JSON.stringify(response));
          }
        } catch (e) {
          console.error('[ws] parse error:', e.message);
        }
      });

      ws.on('close', () => {
        clearInterval(keepAlive);
        connections.delete(connectionId);
      });

      ws.on('error', (e) => console.error('[ws] error:', e.message));
    });
  } else {
    socket.destroy();
  }
});

// ── Start ──

function startServer(port) {
  if (port) PORT = port;
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      const printers = listPrinters();
      console.log('');
      console.log('  Mainchain Printing Tool (macOS)');
      console.log('  ================================');
      console.log(`  Listening on http://localhost:${PORT}`);
      console.log(`  Printers found: ${printers.length}`);
      printers.forEach(p => {
        console.log(`    ${p.IsDefault ? '*' : ' '} ${p.Name} (${p.Status})`);
      });
      console.log('  ================================');
      console.log('');
      resolve({ port: PORT, printers });
    });
  });
}

// If run directly (not required as module), start immediately
if (require.main === module) {
  startServer();
}

module.exports = { startServer, listPrinters, PORT };
