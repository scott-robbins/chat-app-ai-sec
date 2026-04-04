// Replace JUST your sendMessage function with this updated version:

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

        // --- NEW BINARY HANDLER ---
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("image/png")) {
            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);
            const prompt = decodeURIComponent(response.headers.get("x-jolene-prompt") || "Image");

            typingIndicator.classList.remove("visible");
            assistantTextEl.innerHTML = `<p><strong>Jolene's Vision:</strong> "${prompt}"</p><img src="${imageUrl}" style="width:100%; border-radius:12px; display:block; margin-top:10px;" />`;
            chatHistory.push({ role: "assistant", content: `Generated Image: ${prompt}` });
            chatMessages.scrollTop = chatMessages.scrollHeight;
            return;
        }

        // --- REGULAR TEXT HANDLER ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n\n");
            for (const line of lines) {
                const data = line.replace(/^data: /, "").trim();
                if (!data || data === "[DONE]") continue;
                try {
                    const json = JSON.parse(data);
                    responseText += json.response || json.choices?.[0]?.delta?.content || "";
                    assistantTextEl.innerHTML = marked.parse(responseText);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                } catch (e) {}
            }
        }
        chatHistory.push({ role: "assistant", content: responseText });

    } catch (error) {
        if (assistantTextEl) assistantTextEl.innerHTML = `<p>Error: ${error.message}</p>`;
    } finally {
        typingIndicator.classList.remove("visible");
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        pendingImageBase64 = null;
    }
}
