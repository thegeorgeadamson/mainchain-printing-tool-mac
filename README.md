# Mainchain Printing Tool for macOS

A macOS replacement for the Windows-only [Mainchain Printing Tool](https://help.mainfreight.com/global/en/home/freman-05-printing.html). Enables direct printing from Freman (Mainchain's freight management system) on Mac.

The official MPT is a .NET Windows application. This project reverse-engineers the SignalR protocol it uses and reimplements it as a lightweight Node.js server, allowing Freman to discover your macOS printers and send print jobs directly.

## Prerequisites

- **macOS** with printers configured in System Settings > Printers & Scanners
- **Node.js** 18 or later
- Printers connected via USB or network (configured through CUPS)

## Installation

```bash
git clone https://github.com/yourusername/mainchain-printing-tool-mac.git
cd mainchain-printing-tool-mac
npm install
```

## Usage

```bash
node server.js
```

You should see:

```
  Mainchain Printing Tool (macOS)
  ================================
  Listening on http://localhost:50515
  Printers found: 2
    * TOSHIBA_e_STUDIO409S (Idle)
      TOSHIBA_e_STUDIO5525AC (Idle)
  ================================
```

### Configure Freman

1. Log into Freman
2. Go to **Maintain > Settings > Printing**
3. Set **Mainchain Printing Tool Link** to `http://localhost:50515`
4. Click **Test connection** - you should see a green success banner
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

The printer will immediately be available in Freman without restarting the server.

## Auto-Start at Login

To run automatically when you log in, install the included LaunchAgent:

```bash
cp com.mainchain.mpt.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mainchain.mpt.plist
```

To stop auto-starting:

```bash
launchctl unload ~/Library/LaunchAgents/com.mainchain.mpt.plist
rm ~/Library/LaunchAgents/com.mainchain.mpt.plist
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MPT_PORT` | `50515` | Port to listen on |

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
