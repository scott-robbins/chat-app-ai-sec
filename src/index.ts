<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jolene AI</title>
    <script src="https://unpkg.com/@phosphor-icons/web"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    
    <style>
        /* --- CORE JOLENE THEME --- */
        :root {
            --primary: #f6821f;
            --primary-hover: #e67e22;
            --body-bg: #0f172a;
            --app-bg: rgba(30, 41, 59, 0.7);
            --border: rgba(255, 255, 255, 0.15);
            --text: #f8fafc;
        }

        body.theme-plain {
            --body-bg: #f8fafc;
            --app-bg: #ffffff;
            --text: #1e293b;
            --border: #e2e8f0;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, system-ui, sans-serif;
            background: var(--body-bg);
            color: var(--text);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 2rem 1rem;
            transition: background 0.5s ease;
            overflow: hidden;
        }

        /* --- LAVA LAMP --- */
        .lava-lamp { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: -1; }
        body.theme-plain .lava-lamp { display: none; }
        .blob { position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.6; animation: float 15s infinite alternate; }
        .blob1 { width: 450px; height: 450px; background: var(--primary); top: -100px; left: -100px; }
        .blob2 { width: 500px; height: 500px; background: #d95d14; bottom: -150px; right: -100px; }
        @keyframes float { 100% { transform: translate(100px, -50px) scale(1.1); } }

        /* --- HEADER & BUTTONS --- */
        header { text-align: center; margin-bottom: 2rem; width: 100%; max-width: 800px; }
        header h1 { font-size: 3rem; color: #fff; text-shadow: 0 0 20px rgba(246, 130, 31, 0.6); margin-bottom: 1rem; }
        
        .controls { display: flex; justify-content: center; gap: 12px; }
        button { 
            padding: 10px 20px; border-radius: 12px; cursor: pointer; border: none; font-weight: 600; 
            display: flex; align-items: center; gap: 8px; transition: 0.2s;
        }
        .btn-clear { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid var(--border); }
        .btn-new { background: var(--primary); color: #fff; }

        /* --- SETTINGS DROPDOWN --- */
        .dropdown { position: relative; }
        .dropdown-menu {
            display: none; position: absolute; top: 120%; right: 0; background: #1e293b;
            min-width: 240px; border-radius: 16px; border: 1px solid var(--border);
            box-shadow: 0 15px 40px rgba(0,0,0,0.5); z-index: 1000; overflow: hidden;
        }
        .dropdown-menu.show { display: block; }
        .menu-item { padding: 14px 18px; color: #fff; display: flex; align-items: center; gap: 12px; cursor: pointer; }
        .menu-item:hover { background: var(--primary); }

        /* --- CHAT CONTAINER --- */
        .chat-container {
            width: 100%; max-width: 850px; height: calc(100vh - 350px);
            background: var(--app-bg); border: 1px solid var(--border);
            border-radius: 28px; backdrop-filter: blur(25px); display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 25px 60px rgba(0,0,0,0.4);
        }
        #chat-messages { flex: 1; overflow-y: auto; padding: 2.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
        .message-input { padding: 1.5rem 2rem; background: rgba(0,0,0,0.2); border-top: 1px solid var(--border); }
        
        textarea {
            width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--border);
            color: #fff; border-radius: 14px; padding: 14px; resize: none; outline: none; font-size: 1rem;
        }
        .send-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
    </style>
</head>
<body class="theme-fancy">
    <div class="lava-lamp">
        <div class="blob blob1"></div>
        <div class="blob blob2"></div>
    </div>

    <header>
        <h1>Jolene</h1>
        <div class="controls">
            <button class="btn-clear" onclick="clearScreen()"><i class="ph ph-trash"></i> Clear</button>
            <button class="btn-new" onclick="newChat()"><i class="ph ph-plus"></i> New Chat</button>
            <div class="dropdown">
                <button class="btn-clear" onclick="toggleSettings()"><i class="ph ph-gear"></i> Settings</button>
                <div id="settings-menu" class="dropdown-menu">
                    <div class="menu-item" onclick="toggleTheme()"><i class="ph ph-magic-wand"></i> Theme</div>
                    <div class="menu-item" onclick="openSidebar()"><i class="ph ph-database"></i> Memory</div>
                    <div class="menu-item" onclick="openHelp()"><i class="ph ph-question"></i> Help</div>
                </div>
            </div>
        </div>
    </header>

    <div class="chat-container">
        <div id="chat-messages">
            <div class="message assistant-message"><p>Hi there! I'm Jolene. I'm here to help you brainstorm, analyze files, or generate some art. What's on your mind today?</p></div>
        </div>
        <div class="message-input">
            <input type="file" id="file-input" style="color:#64748b; font-size: 0.8rem; margin-bottom: 10px; display: block;">
            <div class="send-row">
                <textarea id="user-input" placeholder="Message Jolene..." rows="1"></textarea>
                <button onclick="sendMessage()" class="btn-new" style="border-radius: 50%; width: 50px; height: 50px; padding: 0; justify-content: center;">
                    <i class="ph-fill ph-paper-plane-right" style="font-size: 1.5rem;"></i>
                </button>
            </div>
        </div>
    </div>

    <script src="chat.js"></script>
    <script>
        // Simple UI toggles placed here for absolute reliability
        function toggleSettings() { document.getElementById('settings-menu').classList.toggle('show'); }
        window.onclick = function(e) { if (!e.target.closest('.dropdown')) document.getElementById('settings-menu').classList.remove('show'); }
    </script>
</body>
</html>
