/**
 * LLM Chat App Frontend - UI Polish & Brain Swap Upgrades
 */

// DOM elements
const chatMessages =  document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const fileUpload = document.getElementById("file-upload");
const uploadBtn = document.getElementById("upload-btn");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const modelSelector = document.getElementById("model-selector");

// 1. Session Management
let sessionId = localStorage.getItem("chatSessionId");
if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("chatSessionId", sessionId);
}

let chatHistory = [];
let isProcessing = false;

marked.setOptions({ breaks: true });

// 2. Load History & Config on Page Load
window.addEventListener('DOMContentLoaded', async () => {
    // Load History
    try {
        const response = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (response.ok) {
            const data = await response.json();
            if (data.messages && data.messages.length > 0) {
                chatMessages.innerHTML = '';
                chatHistory = data.messages;
                chatHistory.forEach(msg => {
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content);
                });
            }
        }
    } catch (e) { console.error("Could not load history"); }

    // Load Active Model from KV
    try {
        const configRes = await fetch('/api/config');
        if (configRes.ok) {
            const config = await configRes.json();
            if (modelSelector && config.model) {
                modelSelector.value = config.model;
            }
        }
    } catch (e) { console.error("Could not load config"); }
});

userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
	const message = userInput.value.trim();
	if (message === "" || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);
	userInput.value = "";
	userInput.style.height = "auto";
	typingIndicator.classList.add("visible");

	chatHistory.push({ role: "user", content: message });

	let assistantTextEl;
	let assistantMessageEl;

	try {
		assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<div class='message-content'></div>";
		chatMessages.appendChild(assistantMessageEl);
		assistantTextEl = assistantMessageEl.querySelector(".message-content");
		chatMessages.scrollTop = chatMessages.scrollHeight;

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-session-id": sessionId },
			body: JSON.stringify({ messages: chatHistory }),
		});

		if (response.status === 403) {
			let blockMessage = "Request blocked by Security Policy.";
			try {
				const rawResponse = await response.text();
				const wafData = JSON.parse(rawResponse);
				if (wafData && wafData.message) blockMessage = wafData.message;
			} catch (e) {}
			
			assistantTextEl.innerHTML = marked.parse(blockMessage);
			chatHistory.push({ role: "assistant", content: blockMessage });
			
            fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-session-id": sessionId },
                body: JSON.stringify({ messages: chatHistory })
            });
			chatMessages.scrollTop = chatMessages.scrollHeight;
			return; 
		}

		if (!response.ok) throw new Error("Failed to get response");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		const flushAssistantText = () => {
			assistantTextEl.innerHTML = marked.parse(responseText);
			assistantMessageEl.querySelectorAll('pre code').forEach((block) => {
				hljs.highlightElement(block);
			});
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		let sawDone = false;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			for (const data of parsed.events) {
				if (data === "[DONE]") { sawDone = true; break; }
				try {
					const jsonData = JSON.parse(data);
					let content = "";
					if (typeof jsonData.response === "string") content = jsonData.response;
					else if (jsonData.choices?.[0]?.delta?.content) content = jsonData.choices[0].delta.content;
					
					if (content) {
						responseText += content;
						flushAssistantText();
					}
				} catch (e) {}
			}
			if (sawDone) break;
		}

		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
            fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-session-id": sessionId },
                body: JSON.stringify({ messages: chatHistory })
            });
		}

	} catch (error) {
		if (assistantTextEl) assistantTextEl.innerHTML = "<p>Sorry, there was an error processing your request.</p>";
	} finally {
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	
	const contentEl = document.createElement("div");
	contentEl.className = "message-content";
	
	if (role === "assistant" || role === "system") {
		contentEl.innerHTML = marked.parse(content);
	} else {
		contentEl.textContent = content;
	}
	
	messageEl.appendChild(contentEl);
	chatMessages.appendChild(messageEl);

	if (role === "assistant" || role === "system") {
		messageEl.querySelectorAll('pre code').forEach((block) => {
			hljs.highlightElement(block);
		});
	}

	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);
		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}

// ==========================================
// UI CONTROLS 
// ==========================================

if (clearScreenBtn) {
    clearScreenBtn.addEventListener("click", () => {
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'Screen cleared! But I still remember our conversation context. *(Refresh the page to bring the history back).*');
    });
}

if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
        sessionId = crypto.randomUUID();
        localStorage.setItem("chatSessionId", sessionId);
        chatHistory = [];
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'Started a brand new chat session! The previous conversation was safely saved to the database. How can I help you?');
    });
}

if (uploadBtn && fileUpload) {
    uploadBtn.addEventListener("click", async () => {
        const file = fileUpload.files[0];
        if (!file) { alert("Please select a text file first!"); return; }

        uploadBtn.disabled = true;
        uploadBtn.innerHTML = "<i class='ph ph-spinner-gap'></i> Uploading...";

        const formData = new FormData();
        formData.append("file", file);

        try {
            const response = await fetch("/api/upload", { method: "POST", body: formData });
            const result = await response.json();
            
            if (response.ok) {
                addMessageToChat('system', `**SYSTEM:** ${result.message}`);
                fileUpload.value = ""; 
            } else { alert("Error: " + result.error); }
        } catch (e) {
            alert("Upload failed. Check console.");
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = "<i class='ph ph-paperclip'></i> Memorize File";
        }
    });
}

// ==========================================
// AESTHETICS (Theme Toggle Logic)
// ==========================================
const savedTheme = localStorage.getItem("chatTheme");
if (savedTheme === "fancy") {
    document.body.classList.add("theme-fancy");
}

if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("theme-fancy");
        if (document.body.classList.contains("theme-fancy")) {
            localStorage.setItem("chatTheme", "fancy");
        } else {
            localStorage.setItem("chatTheme", "plain");
        }
    });
}

// ==========================================
// BRAIN SWAP (Model Selection Logic)
// ==========================================
if (modelSelector) {
    modelSelector.addEventListener("change", async (e) => {
        const newModel = e.target.value;
        modelSelector.disabled = true; // Briefly disable while updating

        try {
            const res = await fetch(`/api/set-model?name=${encodeURIComponent(newModel)}`);
            if (res.ok) {
                // Show a clean system notification in the chat
                addMessageToChat('system', `**SYSTEM:** Brain swap successful! Jolene is now running on \`${newModel}\`.`);
            } else {
                alert("Failed to swap brain.");
            }
        } catch (err) {
            alert("Failed to swap brain. Check console.");
        } finally {
            modelSelector.disabled = false;
        }
    });
}
