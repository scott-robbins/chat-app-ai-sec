/**
 * LLM Chat App Frontend - UI Polish, Vision & Art Generation Support
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
let pendingImageBase64 = null; // NEW: Holds the image until you hit send

marked.setOptions({ breaks: true });

// 2. Load History & Config on Page Load
window.addEventListener('DOMContentLoaded', async () => {
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

// NEW: Listener to catch when a user picks an image file
if (fileUpload) {
    fileUpload.addEventListener("change", () => {
        const file = fileUpload.files[0];
        if (file && file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (e) => {
                pendingImageBase64 = e.target.result;
                addMessageToChat('system', `**SYSTEM:** Attached \`${file.name}\`. Ready to analyze!`);
            };
            reader.readAsDataURL(file);
        }
    });
}

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

        // UPDATED PAYLOAD: Include the image if it exists
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-session-id": sessionId },
			body: JSON.stringify({ 
                messages: chatHistory,
                image: pendingImageBase64 
            }),
		});

        // NEW: Check if the response is an image (Art Gen)
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            if (data.image) {
                typingIndicator.classList.remove("visible");
                const html = `<p>${data.description}</p><img src="${data.image}" style="width:100%; border-radius:12px; margin-top:10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" />`;
                assistantTextEl.innerHTML = html;
                chatHistory.push({ role: "assistant", content: html });
                return;
            }
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
					let content = jsonData.response || jsonData.choices?.[0]?.delta?.content || "";
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
		}

	} catch (error) {
		if (assistantTextEl) assistantTextEl.innerHTML = "<p>Sorry, there was an error processing your request.</p>";
	} finally {
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
        pendingImageBase64 = null; // Clear the image after sending
        if (fileUpload) fileUpload.value = ""; // Reset the picker
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

// UI Controls & Theme
if (clearScreenBtn) {
    clearScreenBtn.addEventListener("click", () => {
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'Screen cleared!');
    });
}

if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
        sessionId = crypto.randomUUID();
        localStorage.setItem("chatSessionId", sessionId);
        chatHistory = [];
        chatMessages.innerHTML = '';
        addMessageToChat('assistant', 'New session started.');
    });
}

if (uploadBtn && fileUpload) {
    uploadBtn.addEventListener("click", async () => {
        const file = fileUpload.files[0];
        if (!file || file.type.startsWith("image/")) return; // Image upload handled in chat flow

        uploadBtn.disabled = true;
        uploadBtn.innerHTML = "Uploading...";
        const formData = new FormData();
        formData.append("file", file);
        try {
            const response = await fetch("/api/upload", { method: "POST", body: formData });
            const result = await response.json();
            if (response.ok) {
                addMessageToChat('system', `**SYSTEM:** ${result.message}`);
                fileUpload.value = ""; 
            }
        } catch (e) { alert("Upload failed."); } 
        finally {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = "<i class='ph ph-paperclip'></i> Memorize File";
        }
    });
}

const savedTheme = localStorage.getItem("chatTheme");
if (savedTheme === "fancy") document.body.classList.add("theme-fancy");

if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("theme-fancy");
        localStorage.setItem("chatTheme", document.body.classList.contains("theme-fancy") ? "fancy" : "plain");
    });
}

if (modelSelector) {
    modelSelector.addEventListener("change", async (e) => {
        const newModel = e.target.value;
        await fetch(`/api/set-model?name=${encodeURIComponent(newModel)}`);
        addMessageToChat('system', `**SYSTEM:** Jolene is now running on \`${newModel}\`.`);
    });
}
