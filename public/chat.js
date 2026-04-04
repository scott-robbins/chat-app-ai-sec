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

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-session-id": sessionId },
			body: JSON.stringify({ messages: chatHistory, image: pendingImageBase64 }),
		});

        // HANDLE BINARY IMAGE RESPONSE
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("image/png")) {
            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);
            typingIndicator.classList.remove("visible");
            assistantTextEl.innerHTML = `<img src="${imageUrl}" style="width:100%; border-radius:12px; display:block;" />`;
            chatHistory.push({ role: "assistant", content: `[Generated Image]` });
            return;
        }

		if (!response.ok) throw new Error("Failed response");

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
		if (assistantTextEl) assistantTextEl.innerHTML = "<p>Error processing request.</p>";
	} finally {
		typingIndicator.classList.remove("visible");
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
        pendingImageBase64 = null;
		userInput.focus();
	}
}
