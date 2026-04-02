/**
 * LLM Chat App Frontend - Now with Persistent Sessions & UI Controls & R2 Uploads
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const fileUpload = document.getElementById("file-upload");
const uploadBtn = document.getElementById("upload-btn");

// 1. Session Management
let sessionId = localStorage.getItem("chatSessionId");
if (!sessionId) {
    // Generate a random ID if the user is new
    sessionId = crypto.randomUUID();
    localStorage.setItem("chatSessionId", sessionId);
}

let chatHistory = [];
let isProcessing = false;

// 2. Load History on Page Load
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/history', {
            headers: { 'x-session-id': sessionId }
        });
        if (response.ok) {
            const data = await response.json();
            if (data.messages && data.messages.length > 0) {
                // Clear the default greeting and load history
                chatMessages.innerHTML = '';
                chatHistory = data.messages;
                
                // Render past messages (ignoring system prompts)
                chatHistory.forEach(msg => {
                    if (msg.role !== "system") {
                        addMessageToChat(msg.role, msg.content);
                    }
                });
            }
        }
    } catch (e) {
        console.error("Could not load history");
    }
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

	// Add new message to our local array before sending to the server
	chatHistory.push({ role: "user", content: message });

	let assistantTextEl;

	try {
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);
		assistantTextEl = assistantMessageEl.querySelector("p");
		chatMessages.scrollTop = chatMessages.scrollHeight;

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
                "x-session-id": sessionId // Pass the session ID to the Worker!
			},
			body: JSON.stringify({ messages: chatHistory }),
		});

		// WAF Intercept
		if (response.status === 403) {
			let blockMessage = "Request blocked by Security Policy.";
			try {
				const rawResponse = await response.text();
				const wafData = JSON.parse(rawResponse);
				if (wafData && wafData.message) blockMessage = wafData.message;
			} catch (e) {}
			
			assistantTextEl.textContent = blockMessage;
			chatHistory.push({ role: "assistant", content: blockMessage });
			
            // Save the block message to the server history too!
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
			assistantTextEl.textContent = responseText;
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
				if (data === "[DONE]") {
					sawDone = true;
					break;
				}
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

		// When stream is done, add AI response to array and do one final sync to the server
		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
            
            // Sync the final AI answer to the Durable Object storage
            fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-session-id": sessionId },
                body: JSON.stringify({ messages: chatHistory })
            });
		}

	} catch (error) {
		if (assistantTextEl) assistantTextEl.textContent = "Sorry, there was an error processing your request.";
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
	messageEl.innerHTML = `<p>${content}</p>`;
	chatMessages.appendChild(messageEl);
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
// UI CONTROLS (Clear Screen & New Chat)
// ==========================================

// Option 1: Clear the UI, but keep the current session memory intact
if (clearScreenBtn) {
    clearScreenBtn.addEventListener("click", () => {
        // We only clear the HTML. We DO NOT clear the chatHistory array or Session ID!
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'Screen cleared! But I still remember our conversation context. (Refresh the page to bring the history back).');
    });
}

// Option 2: Start a brand new session, but leave the old one safely in the database
if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
        // 1. Generate a brand new Session ID
        sessionId = crypto.randomUUID();
        localStorage.setItem("chatSessionId", sessionId);
        
        // 2. Wipe the local history array clean
        chatHistory = [];
        
        // 3. Clear the UI
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'Started a brand new chat session! The previous conversation was safely saved to the database. How can I help you?');
    });
}

// ==========================================
// FILE UPLOAD HANDLING (R2 + Vectorize)
// ==========================================

if (uploadBtn && fileUpload) {
    uploadBtn.addEventListener("click", async () => {
        const file = fileUpload.files[0];
        if (!file) {
            alert("Please select a text file first!");
            return;
        }

        uploadBtn.disabled = true;
        uploadBtn.textContent = "Uploading & Learning...";

        const formData = new FormData();
        formData.append("file", file);

        try {
            const response = await fetch("/api/upload", {
                method: "POST",
                body: formData
            });
            const result = await response.json();
            
            if (response.ok) {
                addMessageToChat('system', `SYSTEM: ${result.message}`);
                fileUpload.value = ""; // clear the input
            } else {
                alert("Error: " + result.error);
            }
        } catch (e) {
            alert("Upload failed. Check console.");
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.textContent = "Memorize File";
        }
    });
}
