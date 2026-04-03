/**
 * LLM Chat App Frontend - Full Multimodal Upgrade, Maintenance Mode, Personality Swap & Image Gen
 */

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
const promptSelector = document.getElementById("prompt-selector");

let sessionId = localStorage.getItem("chatSessionId");
if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("chatSessionId", sessionId);
}

let chatHistory = [];
let isProcessing = false;
let pendingImageBase64 = null; 

marked.setOptions({ breaks: true });

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
            if (modelSelector && config.model) modelSelector.value = config.model;
            
            if (promptSelector && config.prompt) {
                let optionExists = Array.from(promptSelector.options).some(opt => opt.value === config.prompt);
                if (!optionExists) {
                    promptSelector.add(new Option("Custom Personality", config.prompt));
                }
                promptSelector.value = config.prompt;
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

if (fileUpload) {
    fileUpload.addEventListener("change", () => {
        const file = fileUpload.files[0];
        if (!file) return;
        
        if (file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (e) => {
                pendingImageBase64 = e.target.result;
                addMessageToChat('system', `**SYSTEM:** Attached image \`${file.name}\`. Type your question about it and hit Send!`);
            };
            reader.readAsDataURL(file);
        }
    });
}

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

        const payload = { messages: chatHistory };
        if (pendingImageBase64) {
            payload.image = pendingImageBase64;
        }

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-session-id": sessionId },
			body: JSON.stringify(payload),
		});

		if (response.status === 403) {
			let blockMessage = "Request blocked by Security Policy.";
			assistantTextEl.innerHTML = marked.parse(blockMessage);
			chatHistory.push({ role: "assistant", content: blockMessage });
			chatMessages.scrollTop = chatMessages.scrollHeight;
			return; 
		}

		if (response.status === 503) {
			const errorData = await response.json();
			assistantTextEl.innerHTML = marked.parse(`**SYSTEM:** ${errorData.error}`);
			chatHistory.push({ role: "assistant", content: errorData.error });
			chatMessages.scrollTop = chatMessages.scrollHeight;
			return; 
		}

		if (!response.ok) throw new Error("Failed to get response");

        // --- NEW: LOGIC TO HANDLE IMAGE GENERATION RESPONSES ---
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            if (data.image) {
                typingIndicator.classList.remove("visible");
                const imgHtml = `<p>${data.description}</p><img src="${data.image}" style="width:100%; border-radius:12px; margin-top:10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" />`;
                assistantTextEl.innerHTML = imgHtml;
                chatHistory.push({ role: "assistant", content: imgHtml });
                chatMessages.scrollTop = chatMessages.scrollHeight;
                
                // Save the "assistant" message to DO storage manually since it wasn't a stream
                fetch("/api/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
                    body: JSON.stringify({ messages: chatHistory })
                });
                
                isProcessing = false;
                sendButton.disabled = false;
                userInput.disabled = false;
                return; // Stop here, no stream to read
            }
        }
        // --- END IMAGE GEN LOGIC ---

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";

		const flushAssistantText = () => {
			assistantTextEl.innerHTML = marked.parse(responseText);
			assistantMessageEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
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
        
        pendingImageBase64 = null;
        if (fileUpload) fileUpload.value = "";
        
		userInput.focus();
	}
}

function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	
	const contentEl = document.createElement("div");
	contentEl.className = "message-content";
	
    // If content contains an img tag (from history), don't treat it as raw text
	if (role === "assistant" || role === "system") {
		contentEl.innerHTML = marked.parse(content);
	} else {
		contentEl.textContent = content;
	}
	
	messageEl.appendChild(contentEl);
	chatMessages.appendChild(messageEl);

	if (role === "assistant" || role === "system") {
		messageEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
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
        if (!file) { alert("Please select a text file or PDF first!"); return; }

        if (file.type.startsWith("image/")) {
            alert("Images are handled directly in the chat! Just type a question and click the 'Send' button instead.");
            return;
        }

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
        modelSelector.disabled = true; 

        try {
            const res = await fetch(`/api/set-model?name=${encodeURIComponent(newModel)}`);
            if (res.ok) {
                addMessageToChat('system', `**SYSTEM:** Brain swap successful! Jolene is now running on \`${newModel}\`.`);
            } else { alert("Failed to swap brain."); }
        } catch (err) {
            alert("Failed to swap brain. Check console.");
        } finally {
            modelSelector.disabled = false;
        }
    });
}

if (promptSelector) {
    promptSelector.addEventListener("change", async (e) => {
        const newPrompt = e.target.value;
        promptSelector.disabled = true; 

        try {
            const res = await fetch(`/api/set-prompt?text=${encodeURIComponent(newPrompt)}`);
            if (res.ok) {
                const selectedText = promptSelector.options[promptSelector.selectedIndex].text;
                addMessageToChat('system', `**SYSTEM:** Personality swap successful! Jolene is now acting as: \`${selectedText}\`.`);
            } else { alert("Failed to change personality."); }
        } catch (err) {
            alert("Failed to change personality. Check console.");
        } finally {
            promptSelector.disabled = false;
        }
    });
}
