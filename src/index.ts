<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Jolene AI</title>
		
		<script src="https://unpkg.com/@phosphor-icons/web"></script>
		<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
		<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/tokyo-night-dark.min.css">
		<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

		<style>
			:root {
				--primary-color: #f6821f;
				--primary-hover: #e67e22;
				--primary-light: rgba(246, 130, 31, 0.1);
				--light-bg: #f4f6f8;
				--app-bg: #ffffff;
				--border-color: #e2e8f0;
				--text-color: #1e293b;
				--text-color-dark: #0f172a;
				--text-light: #64748b;
				--user-msg-bg: #f6821f;
				--user-msg-text: #ffffff;
				--assistant-msg-bg: #ffffff;
				--body-bg: linear-gradient(135deg, #fffaf5 0%, #f4f6f8 100%);
			}

			body.theme-fancy {
				--app-bg: rgba(30, 41, 59, 0.4); 
				--light-bg: transparent; 
				--border-color: rgba(255, 255, 255, 0.1);
				--text-color: #f8fafc;
				--text-light: #cbd5e1;
				--assistant-msg-bg: rgba(255, 255, 255, 0.05);
				--body-bg: #0f172a;
			}

			body.theme-fancy .chat-container, body.theme-fancy .sidebar {
				backdrop-filter: blur(25px) saturate(180%);
				-webkit-backdrop-filter: blur(25px) saturate(180%);
				border: 1px solid rgba(255, 255, 255, 0.2);
				box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
				background-color: var(--app-bg);
			}

			body.theme-fancy #user-input {
				background-color: rgba(0, 0, 0, 0.2);
				color: white;
				border: 1px solid rgba(255, 255, 255, 0.1);
			}

			body.theme-fancy header h1 {
				color: #ffffff;
				text-shadow: 0 0 20px rgba(246, 130, 31, 0.4);
			}

			* { box-sizing: border-box; margin: 0; padding: 0; }

			body {
				font-family: -apple-system, system-ui, sans-serif;
				color: var(--text-color);
				background: var(--body-bg);
				min-height: 100vh;
				display: flex;
				flex-direction: column;
				align-items: center;
				padding: 2rem 1rem;
				transition: background 0.5s ease;
				overflow-x: hidden;
			}

			.lava-lamp-container {
				position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
				z-index: -1; overflow: hidden; display: none;
				pointer-events: none;
			}
			body.theme-fancy .lava-lamp-container { display: block; }
			
			.blob {
				position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.5;
				animation: float 15s infinite alternate ease-in-out;
			}
			.blob1 { width: 500px; height: 500px; background: #f6821f; top: -100px; left: -100px; }
			.blob2 { width: 600px; height: 600px; background: #d95d14; bottom: -150px; right: -100px; }
			.blob3 { width: 400px; height: 400px; background: #faad3f; top: 30%; left: 60%; animation-delay: -5s; }

			@keyframes float {
				0% { transform: translate(0, 0) scale(1); }
				100% { transform: translate(120px, -60px) scale(1.1); }
			}

			header { text-align: center; margin-bottom: 2rem; width: 100%; max-width: 800px; }
			h1 { font-size: 2rem; color: var(--primary-color); font-weight: 800; letter-spacing: -1px; }
			header p { color: var(--text-light); font-size: 1rem; margin-top: 0.25rem; opacity: 0.8; }

			.chat-container {
				display: flex; flex-direction: column; width: 100%; max-width: 850px;
				height: calc(100vh - 280px); min-height: 500px; background-color: var(--app-bg);
				border-radius: 24px; overflow: hidden; border: 1px solid var(--border-color);
				transition: all 0.3s ease;
			}

			#chat-messages {
				flex: 1; overflow-y: auto; padding: 2rem; background-color: var(--light-bg);
				display: flex; flex-direction: column; gap: 1.5rem;
			}

			.message { padding: 1rem 1.25rem; max-width: 80%; border-radius: 18px; font-size: 0.95rem; line-height: 1.6; }
			.user-message { background-color: var(--user-msg-bg); color: var(--user-msg-text); align-self: flex-end; border-radius: 18px 18px 4px 18px; box-shadow: 0 4px 15px rgba(246, 130, 31, 0.2); }
			.assistant-message { background-color: var(--assistant-msg-bg); color: var(--text-color); align-self: flex-start; border-radius: 18px 18px 18px 4px; border: 1px solid var(--border-color); }
			.system-indicator { align-self: center; background: rgba(0,0,0,0.05); color: var(--text-light); font-size: 0.75rem; padding: 6px 16px; border-radius: 20px; font-style: italic; border: 1px dashed var(--border-color); margin: 10px 0; }
			body.theme-fancy .system-indicator { background: rgba(255,255,255,0.1); color: #38bdf8; border-color: rgba(56, 189, 248, 0.3); }

			.message-content img {
				max-width: 100%;
				height: auto;
				border-radius: 12px;
				margin: 10px 0;
				display: block;
			}

			#typing-indicator { display: none; align-self: flex-start; }
			#typing-indicator.visible { display: block !important; }
			
			.typing-dots { display: flex; align-items: center; gap: 4px; }
			.typing-dots span { width: 8px; height: 8px; background: var(--primary-color); border-radius: 50%; display: inline-block; animation: bounce 1.3s infinite ease-in-out; }
			.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
			.typing-dots span:nth-child(3) { animation-delay: 0.4s; }
			@keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }

			.message-input {
				display: flex; padding: 1.5rem; background-color: transparent;
				border-top: 1px solid var(--border-color); flex-wrap: wrap; gap: 0.75rem;
			}

			#user-input {
				flex: 1; padding: 1rem; border: 1px solid var(--border-color);
				border-radius: 14px; min-height: 54px; background-color: var(--app-bg); color: inherit; font-family: inherit; resize: none; outline: none;
			}

			#send-button {
				padding: 0 1.5rem; height: 54px; background-color: var(--primary-color); color: white;
				border: none; border-radius: 14px; cursor: pointer; font-size: 1.25rem; transition: transform 0.2s;
			}
			#send-button:hover { transform: scale(1.05); }

			.controls-row { margin-top: 1rem; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
			.btn-secondary { padding: 8px 16px; border-radius: 10px; border: 1px solid var(--border-color); background: var(--app-bg); color: var(--text-color-dark); cursor: pointer; display: flex; align-items: center; gap: 8px; transition: all 0.2s; font-size: 0.85rem; font-weight: 600; }
			
			body.theme-fancy .btn-secondary { color: white; backdrop-filter: blur(10px); }

			.btn-primary { padding: 8px 16px; border-radius: 10px; border: none; background: var(--primary-color); color: white; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.85rem; font-weight: 600; box-shadow: 0 4px 12px rgba(246, 130, 31, 0.3); }

			.sidebar {
				position: fixed; top: 0; right: -400px; width: 350px; height: 100%;
				background: var(--app-bg); border-left: 1px solid var(--border-color);
				transition: right 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); 
				z-index: 1000; padding: 30px; display: flex; flex-direction: column; gap: 15px;
				overflow-y: auto;
			}
			.sidebar.open { right: 0; }
			.btn-danger { width: 100%; margin-top: 20px; padding: 14px; background: #ef4444; color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; }

			.dash-card {
				background: rgba(255, 255, 255, 0.08);
				border: 1px solid var(--border-color);
				border-radius: 12px;
				padding: 12px;
				margin-bottom: 8px;
			}
			.dash-label {
				font-size: 0.65rem;
				font-weight: 800;
				color: var(--primary-color);
				text-transform: uppercase;
				letter-spacing: 1px;
				margin-bottom: 4px;
				display: block;
			}
			.dash-value {
				font-size: 0.85rem;
				font-weight: 500;
				line-height: 1.3;
				word-break: break-word;
			}
			.dash-desc {
				font-size: 0.7rem;
				color: var(--text-light);
				margin-top: 4px;
				font-style: italic;
				margin-bottom: 4px;
			}

			#file-list-display {
				margin-top: 10px;
				padding: 0;
			}
			#file-list-display li {
				font-size: 0.75rem;
				padding: 6px 0;
				border-bottom: 1px solid rgba(255,255,255,0.05);
				color: #38bdf8;
				list-style: none;
				display: flex;
				justify-content: space-between;
				align-items: center;
			}
			
			.delete-file-btn {
				background: none;
				border: none;
				color: #ef4444;
				cursor: pointer;
				font-size: 1rem;
				opacity: 0.6;
				transition: opacity 0.2s;
				padding: 4px;
			}
			.delete-file-btn:hover { opacity: 1; }

		</style>
	</head>
	<body class="theme-fancy">
		<div class="lava-lamp-container">
			<div class="blob blob1"></div>
			<div class="blob blob2"></div>
			<div class="blob blob3"></div>
		</div>

		<header>
			<h1>Jolene</h1>
			<p>Your Personal AI Agent</p>
			
			<div class="controls-row">
				<select id="model-selector" class="btn-secondary">
					<optgroup label="Cloudflare Workers AI">
						<option value="@cf/meta/llama-3.2-11b-vision-instruct" selected>Llama 3.2 Vision (11B)</option>
						<option value="@cf/meta/llama-3.1-8b-instruct">Llama 3.1 (8B)</option>
						<option value="@cf/mistral/mistral-7b-instruct-v0.1">Mistral (7B)</option>
					</optgroup>

					<optgroup label="AI Gateway (ai-sec-gateway)">
						<option value="gpt-4o">GPT-4o (OpenAI)</option>
						<!-- FIXED: Using standard stable ID for Claude 3.5 Sonnet -->
						<option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet (Anthropic)</option>
					</optgroup>
				</select>
				<button id="theme-toggle-btn" class="btn-secondary"><i class="ph ph-magic-wand"></i> Theme</button>
				<button id="voice-toggle-btn" class="btn-secondary"><i class="ph ph-speaker-slash" id="voice-icon"></i> Voice</button>
				<button id="toggle-sidebar-btn" class="btn-secondary"><i class="ph ph-database"></i> Memory</button>
				<button id="clear-screen-btn" class="btn-secondary"><i class="ph ph-trash"></i> Clear Screen</button>
				<button id="new-chat-btn" class="btn-primary"><i class="ph ph-chat-circle-dots"></i> New Chat</button>
			</div>
		</header>

		<div class="chat-container">
			<div id="chat-messages">
				<div class="message assistant-message">
					<div class="message-content">
						<p>Hi there! I'm Jolene. I'm here to help you brainstorm, analyze files, or just chat. What's on your mind today?</p>
					</div>
				</div>
			</div>
			
			<div id="typing-indicator" class="message assistant-message">
				<div class="message-content">
					<div class="typing-dots">
						<span></span><span></span><span></span>
					</div>
				</div>
			</div>

			<div class="message-input">
				<textarea id="user-input" placeholder="Message Jolene..." rows="1"></textarea>
				<button id="send-button"><i class="ph-fill ph-paper-plane-right"></i></button>
			</div>
		</div>

		<div id="memory-sidebar" class="sidebar">
			<div class="sidebar-header">
				<div style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 20px;">
					<h2 style="color: var(--primary-color); font-weight: 700;">Command Center</h2>
					<button id="close-sidebar-btn" style="background:none; border:none; cursor:pointer; font-size:1.5rem; color:inherit;"><i class="ph ph-x"></i></button>
				</div>
			</div>
			<div class="sidebar-content">
				
				<div class="dash-card" id="learning-card" style="border-left: 3px solid #22c55e;">
					<span class="dash-label">Active Learning Session</span>
					<div class="dash-desc">Tracking multi-step academic quiz progress via Durable Objects.</div>
					<div class="dash-value">Session Status: <span id="quiz-status" style="color: #22c55e;">Idle</span></div>
				</div>

				<div class="dash-card">
					<span class="dash-label">Cloudflare KV: User Profile</span>
					<div class="dash-desc">Stores persistent user identity and preferences across sessions.</div>
					<div id="kv-profile-display" class="dash-value">Syncing profile...</div>
				</div>

				<div class="dash-card" style="border-left: 3px solid #f6821f;">
					<span class="dash-label">Cloudflare Durable Objects: State</span>
					<div class="dash-desc">Coordinates real-time consistency and persists DO state across the edge.</div>
					<div class="dash-value">
						ID: <span id="do-id-display" style="font-size: 0.65rem; opacity: 0.7;">Initializing...</span><br>
						Status: <span id="do-status-display" style="color: #22c55e;">Syncing...</span>
					</div>
				</div>

				<div class="dash-card">
					<span class="dash-label">Cloudflare D1: SQL Metrics</span>
					<div class="dash-desc">Relational database tracking chat history and interaction frequency.</div>
					<div class="dash-value">Volume: <span id="msg-count-display">0</span> messages</div>
				</div>

				<div class="dash-card">
					<span class="dash-label">Cloudflare Vectorize: Semantic Memory</span>
					<div class="dash-desc">Stores text embeddings from files for semantic search and "learning."</div>
					<div class="dash-value" id="vector-status">Active Index</div>
				</div>

				<div class="dash-card">
					<span class="dash-label">Cloudflare R2: Knowledge Assets</span>
					<div class="dash-desc">Object storage for raw uploaded documents and generated images.</div>
					<ul id="file-list-display">
						<li>Scanning storage...</li>
					</ul>
				</div>
			</div>
			<button id="clear-vector-btn" class="btn-danger"><i class="ph ph-warning"></i> Reset Identity & History</button>
		</div>

		<footer>
			<p style="margin-top: 2rem; color: var(--text-light); font-size: 0.85rem; font-weight: 500;">Jolene AI &copy; 2026</p>
		</footer>

		<script>
			function getSessionId() {
				let id = localStorage.getItem('jolene_session_id');
				if (!id) {
					id = crypto.randomUUID();
					localStorage.setItem('jolene_session_id', id);
				}
				return id;
			}

			let sessionId = getSessionId();
			let isTyping = false;

			document.getElementById('toggle-sidebar-btn').onclick = () => {
				document.getElementById('memory-sidebar').classList.add('open');
				updateDashboard();
			};
			document.getElementById('close-sidebar-btn').onclick = () => {
				document.getElementById('memory-sidebar').classList.remove('open');
			};

			document.getElementById('clear-screen-btn').onclick = () => {
				document.getElementById('chat-messages').innerHTML = '';
				appendMessage('assistant-message', "Screen cleared. How can I help you now?");
			};

			document.getElementById('new-chat-btn').onclick = () => {
				sessionId = crypto.randomUUID();
				localStorage.setItem('jolene_session_id', sessionId);
				const chatMessages = document.getElementById('chat-messages');
				chatMessages.innerHTML = ''; 
				appendMessage('assistant-message', "New session started. I'm Jolene, ready to assist with your documents, sports updates, or image generation. What's on your agenda?");
				chatMessages.scrollTop = 0;
				updateDashboard();
			};

			document.getElementById('theme-toggle-btn').onclick = () => {
				document.body.classList.toggle('theme-fancy');
			};

			// Robust brain-switch handshake logic
			document.getElementById('model-selector').onchange = async () => {
				const selector = document.getElementById('model-selector');
				const modelName = selector.options[selector.selectedIndex].text;
				
				appendMessage('system-indicator', `System: Optimizing brain pathways for ${modelName}...`);
				
				const switchPrompt = `I have just switched my brain to ${modelName}. Please provide a very brief one-sentence greeting in your unique style to confirm you are active.`;
				await sendMessage(switchPrompt, true);
			};

			async function updateDashboard() {
				try {
					const res = await fetch('/api/profile', { headers: { 'x-session-id': sessionId } });
					const data = await res.json();
					document.getElementById('kv-profile-display').innerText = data.profile || "Not Found";
					document.getElementById('msg-count-display').innerText = data.messageCount || 0;
					if (data.durableObject) {
						document.getElementById('do-id-display').innerText = data.durableObject.id;
						document.getElementById('do-status-display').innerText = data.durableObject.state;
					}
					if (data.activeQuiz) {
						document.getElementById('quiz-status').innerText = "Quiz Active";
					} else {
						document.getElementById('quiz-status').innerText = "Idle";
					}
					
					// Auto-hydrate history on initial load or empty screen
					if (document.getElementById('chat-messages').children.length <= 2 && data.messages && data.messages.length > 0) {
						const chatMessages = document.getElementById('chat-messages');
						chatMessages.innerHTML = ''; 
						data.messages.forEach(msg => {
							appendMessage(msg.role === 'user' ? 'user-message' : 'assistant-message', msg.content, false);
						});
					}

					const list = document.getElementById('file-list-display');
					list.innerHTML = '';
					if (data.knowledgeAssets && data.knowledgeAssets.length > 0) {
						data.knowledgeAssets.forEach(f => {
							const li = document.createElement('li');
							li.innerHTML = `<span>📄 ${f}</span>`;
							list.appendChild(li);
						});
					} else {
						list.innerHTML = '<li>No assets in R2 storage.</li>';
					}
				} catch (e) { console.error("Dashboard error:", e); }
			}

			async function sendMessage(overrideText = null, isAutoSwitch = false) {
				const input = document.getElementById('user-input');
				const content = overrideText || input.value.trim();
				if (!content || isTyping) return;
				
				// Keep the chat clean by hiding the internal model-swap prompt
				if (!isAutoSwitch) appendMessage('user-message', content);
				
				if (!overrideText) input.value = '';
				showTyping(true);

				try {
					const res = await fetch('/api/chat', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
						body: JSON.stringify({ 
							messages: [{ role: 'user', content }],
							model: document.getElementById('model-selector').value 
						})
					});

					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let assistantText = "";
					
					const chatContainer = document.getElementById('chat-messages');
					const msgDiv = document.createElement('div');
					msgDiv.className = 'message assistant-message';
					msgDiv.innerHTML = '<div class="message-content"></div>';
					chatContainer.appendChild(msgDiv);
					const contentDiv = msgDiv.querySelector('.message-content');

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						const chunk = decoder.decode(value);
						const lines = chunk.split('\n');
						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const dataStr = line.substring(6).trim();
								if (dataStr === '[DONE]') continue;
								try {
									const data = JSON.parse(dataStr);
									if (data.response) {
										assistantText += data.response;
										contentDiv.innerHTML = marked.parse(assistantText);
										chatContainer.scrollTop = chatContainer.scrollHeight;
									}
								} catch (e) {}
							}
						}
					}
					showTyping(false);
					updateDashboard();
				} catch (e) {
					showTyping(false);
					appendMessage('assistant-message', `**Error:** Failed to execute brain swap. Check console or dashboard secrets. Details: ${e.message}`);
				}
			}

			function appendMessage(cls, text, scroll = true) {
				const container = document.getElementById('chat-messages');
				const div = document.createElement('div');
				div.className = cls === 'system-indicator' ? 'system-indicator' : `message ${cls}`;
				if (cls === 'system-indicator') {
					div.innerText = text;
				} else {
					div.innerHTML = `<div class="message-content">${marked.parse(text)}</div>`;
				}
				container.appendChild(div);
				if (scroll) container.scrollTop = container.scrollHeight;
			}

			function showTyping(show) {
				isTyping = show;
				document.getElementById('typing-indicator').classList.toggle('visible', show);
			}

			document.getElementById('send-button').onclick = () => sendMessage();
			document.getElementById('user-input').onkeypress = (e) => { if(e.key === 'Enter') { e.preventDefault(); sendMessage(); } };
			
			updateDashboard();
		</script>
	</body>
</html>
