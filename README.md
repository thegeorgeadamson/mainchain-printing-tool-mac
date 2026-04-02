# Mainchain Printing Tool for macOS

A macOS replacement for the Windows-only [Mainchain Printing Tool](https://help.mainfreight.com/global/en/home/freman-05-printing.html). Enables direct printing from Freman (Mainchain's freight management system) on Mac.

The official MPT is a .NET Windows application. This project reverse-engineers the SignalR protocol it uses and reimplements it as a lightweight Node.js server, allowing Freman to discover your macOS printers and send print jobs directly.

## Prerequisites

- **macOS** with printers configured in System Settings > Printers & Scanners
- **Node.js** 18 or later
- Printers connected via USB or network (configured through CUPS)

## Installation

```bash
git clone https://github.com/thegeorgeadamson/mainchain-printing-tool-mac.git
cd mainchain-printing-tool-mac
npm install
```

## Usage

### Menu Bar App (recommended)

```bash
npm start
```

This launches the Electron menu bar app with:
- A printer icon in the macOS menu bar
- Dropdown showing status, detected printers, and recent print jobs
- Right-click menu to change port, open Freman, or run the setup wizard
- First-launch setup wizard that walks you through configuration

### CLI / Headless Mode

If you just want the server without the GUI:

```bash
node server.js
```

### Configure Freman

1. Log into Freman
2. Go to **Maintain > Settings > Printing**
3. Set **Mainchain Printing Tool Link** to `http://localhost:50515`
4. Click **Test connection** — you should see a green success banner
5. Click the **edit icon** on each print type to assign a printer
6. Click **Save**

## Adding Printers

Any printer configured in **System Settings > Printers & Scanners** will automatically appear in Freman. To add a network printer:

1. Open **System Settings > Printers & Scanners**
2. Click **Add Printer, Scanner, or Fax...**
3. Click the **IP** tab
4. Enter the printer's IP address
5. Select the appropriate driver (or "Generic PostScript Printer" / "Generic PCL Printer")
6. Click **Add**

The printer will immediately be available in Freman without restarting.

## Configuration

The port can be changed from:
- The **setup wizard** (first launch)
- **Right-click** the menu bar icon > "Change Port..."
- The `MPT_PORT` environment variable (CLI mode)

Config is stored in `~/.mpt-mac/config.json`.

## Auto-Start at Login

From the setup wizard, check **"Start automatically when I log in"**. This installs a macOS LaunchAgent.

To set up manually:

```bash
cp com.mainchain.mpt.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mainchain.mpt.plist
```

## Print Options

All documents are printed **single-sided** by default to match typical freight documentation requirements.

## How It Works

Freman's web app communicates with the Mainchain Printing Tool via [ASP.NET SignalR](https://learn.microsoft.com/en-us/aspnet/signalr/) (legacy, not Core). This server implements the SignalR protocol:

1. Serves a hub proxy JavaScript file at `/signalr/hubs`
2. Handles WebSocket connections at `/signalr/connect`
3. Responds to hub method calls (`Send`, `GetPrintersInformation`, etc.)
4. Pushes printer data to Freman via the `addMessage` client callback
5. Receives print jobs as base64-encoded PDFs and sends them to `lpr`

## License

MIT
