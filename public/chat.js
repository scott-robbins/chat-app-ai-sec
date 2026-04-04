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

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

let chatHistory = [];
let isProcessing = false;

marked.setOptions({ breaks: true });

window.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (response.ok) {
            const data = await response.json();
            if (data.messages) {
                chatMessages.innerHTML = '';
                chatHistory = data.messages;
                chatHistory.forEach(msg => { if (msg.role !== "system") addMessageToChat(msg.role, msg.content); });
            }
        }
    } catch (e) {}
    try {
        const configRes = await fetch('/api/config');
        if (configRes.ok) {
            const config = await configRes.json();
            if (modelSelector && config.model) modelSelector.value = config.model;
        }
    } catch (e) {}
});

userInput.addEventListener("input", function () { this.style.height = "auto"; this.style.height = this.scrollHeight + "px"; });
userInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
	const message = userInput.value.trim();
	if (message === "" || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;
	addMessageToChat("user", message);
	userInput.value = "";
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

        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            if (data.image) {
                typingIndicator.classList.remove("visible");
                const html = `<p>${data.description}</p><img src="${data.image}" style="width:100%; border-radius:12px; margin-top:10px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);" />`;
                assistantTextEl.innerHTML = html;
                chatHistory.push({ role: "assistant", content: html });
                return;
            }
        }

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n\n");
			buffer = lines.pop();
			for (const line of lines) {
				const data = line.replace(/^data: /, "").trim();
				if (data === "[DONE]") break;
				try {
					const json = JSON.parse(data);
					responseText += json.response || json.choices?.[0]?.delta?.content || "";
					assistantTextEl.innerHTML = marked.parse(responseText);
				} catch (e) {}
			}
		}
		chatHistory.push({ role: "assistant", content: responseText });
	} catch (error) {
		if (assistantTextEl) assistantTextEl.innerHTML = "Error processing request.";
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
	contentEl.innerHTML = (role === "user") ? content : marked.parse(content);
	messageEl.appendChild(contentEl);
	chatMessages.appendChild(messageEl);
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

if (clearScreenBtn) clearScreenBtn.addEventListener("click", () => { chatMessages.innerHTML = ''; });
if (newChatBtn) newChatBtn.addEventListener("click", () => { sessionId = crypto.randomUUID(); localStorage.setItem("chatSessionId", sessionId); location.reload(); });

if (uploadBtn && fileUpload) {
    uploadBtn.addEventListener("click", async () => {
        const file = fileUpload.files[0];
        if (!file) return;
        uploadBtn.innerText = "Uploading...";
        const formData = new FormData();
        formData.append("file", file);
        try {
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            const result = await res.json();
            addMessageToChat('system', result.message || "Done");
        } catch (e) {} finally { uploadBtn.innerText = "Memorize File"; }
    });
}

if (themeToggleBtn) themeToggleBtn.addEventListener("click", () => { document.body.classList.toggle("theme-fancy"); });
if (modelSelector) {
    modelSelector.addEventListener("change", async (e) => {
        await fetch(`/api/set-model?name=${encodeURIComponent(e.target.value)}`);
    });
}
