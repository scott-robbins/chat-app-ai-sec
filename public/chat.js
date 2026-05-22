const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const voiceToggleBtn = document.getElementById("voice-toggle-btn");
const voiceIcon = document.getElementById("voice-icon");
const newChatBtn = document.getElementById("new-chat-btn");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const modelSelector = document.getElementById("model-selector");
const sidebar = document.getElementById("memory-sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar-btn");
const closeSidebarBtn = document.getElementById("close-sidebar-btn");
const kvDisplay = document.getElementById("kv-profile-display");
const fileListDisplay = document.getElementById("file-list-display");
const memorizeBtn = document.getElementById("memorize-file-btn");
const fileInput = document.getElementById("file-input");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;
let voiceEnabled = false; 

// --- THE VOICE ENGINE ---
const synth = window.speechSynthesis;

function speak(text) {
    if (!voiceEnabled || !text || !synth) return;
    synth.cancel();
    const cleanText = text.replace(/[*#_~]/g, "").replace(/\[.*?\]\(.*?\)/g, "").replace(/!\[.*?\]\(.*?\)/g, "");
    const utterance = new SpeechSynthesisUtterance(cleanText);
    const voices = synth.getVoices();
    const joleneVoice = voices.find(v => v.name.includes("Ava (Premium)")) || 
                        voices.find(v => v.name.includes("Siri")) || 
                        voices.find(v => v.name.includes("en-US"));
    
    if (joleneVoice) utterance.voice = joleneVoice;
    utterance.pitch = 1.2; 
    utterance.rate = 1.1;  
    synth.speak(utterance);
}

// --- UI LISTENERS ---
voiceToggleBtn?.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    if (voiceIcon) voiceIcon.className = voiceEnabled ? "ph ph-speaker-high" : "ph ph-speaker-slash";
    if (!voiceEnabled) synth.cancel();
});

themeToggleBtn?.addEventListener("click", async () => {
    const isFancy = document.body.classList.toggle("theme-fancy");
    const currentTheme = isFancy ? "fancy" : "plain";
    localStorage.setItem("chatTheme", currentTheme);
    try {
        await fetch("/api/save-theme", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ theme: currentTheme })
        });
    } catch (e) { console.error("KV Sync Failed", e); }
});

modelSelector?.addEventListener("change", () => {
    const selectedModelName = modelSelector.options[modelSelector.selectedIndex].text;
    const notification = document.createElement("div");
    notification.style = "text-align: center; font-size: 0.75rem; margin: 15px 0; color: var(--text-light); opacity: 0.7;";
    notification.innerHTML = `— Model switched to <strong>${selectedModelName}</strong> —`;
    chatMessages.appendChild(notification);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// --- DASHBOARD UPDATER (UPDATED WITH DO & D1 VOLUME FIX) ---
async function updateSidebarContent() {
    try {
        const res = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const data = await res.json();
        
        // 1. Update Profile/Identity Info
        kvDisplay.innerHTML = `
            <div class="dash-card">
                <p class="dash-label">Global Identity (KV)</p>
                <p class="dash-value">${data.profile}</p>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div class="dash-card">
                    <p class="dash-label">SQL Logs (D1)</p>
                    <p class="dash-value" id="msg-count-display" style="font-size: 1.2rem; color: #60a5fa;">${data.messageCount || 0}</p>
                </div>
                <div class="dash-card">
                    <p class="dash-label">Status</p>
                    <p class="dash-value"><i class="ph ph-circle-wavy-check" style="color: #22c55e;"></i> Live</p>
                </div>
            </div>
            <div class="dash-card" style="border-left: 3px solid #a855f7;">
                <p class="dash-label">Brain (Vectorize)</p>
                <p class="dash-value" style="font-size: 0.7rem; opacity: 0.8;">Indexing: Active | RAG: Enabled</p>
            </div>
        `;

        // 2. Update Durable Object Metrics (New Card)
        if (data.durableObject) {
            document.getElementById('do-id-display').innerText = data.durableObject.id;
            document.getElementById('do-status-display').innerText = data.durableObject.state;
        }

        // 3. Update Knowledge Assets (R2)
        fileListDisplay.innerHTML = ""; 
        if (data.knowledgeAssets && data.knowledgeAssets.length > 0) {
            data.knowledgeAssets.forEach(fileName => {
                const li = document.createElement("li");
                li.style = "display: flex; align-items: center; gap: 8px; font-size: 0.85rem; margin-bottom: 8px; opacity: 0.9;";
                li.innerHTML = `<i class="ph ph-file-text" style="color: var(--primary-color);"></i> <span>${fileName}</span>`;
                fileListDisplay.appendChild(li);
            });
        } else {
            fileListDisplay.innerHTML = "<li style='font-size: 0.8rem; opacity: 0.6;'>No files memorized.</li>";
        }
    } catch (e) { console.error("Sidebar sync failed:", e); }
}

// --- NATIVE FRONTEND WEBRTC HANDSHAKE MANAGER ---
async function executeWebRtcHandshake(cameraLocation, originalAssistantText) {
    try {
        console.log(`🚀 Starting WebRTC negotiation with camera: [${cameraLocation}]`);
        
        // 1. Initialize browser peer context layer mapping Google's open STUN tracker network
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });

        // 2. Provision native tracks for incoming audio/video feeds
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.addTransceiver('video', { direction: 'recvonly' });

        // 3. Generate genuine cryptographic session allocation parameters
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // 4. Send client SDP configuration directly down the pipeline
        const response = await fetch("https://mcp.jolenesego.com/api/tools/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tool: "generate_camera_stream",
                arguments: {
                    camera: cameraLocation,
                    clientSdpOffer: offer.sdp
                }
            })
        });

        const data = await response.json();

        if (data.status === "Success" && data.answerSdp) {
            console.log("✅ WebRTC SDP Answer received from camera engine!");
            
            // 5. Connect the remote answer description back into Chrome's streaming matrix
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: data.answerSdp
            }));

            // 6. Watch for inbound media track allocation hooks
            pc.ontrack = (event) => {
                console.log("🎯 Live camera track landed! Rendering player inside UI container...");
                
                // Remove player if one exists to handle live scene updates cleanly
                const existingPlayer = document.getElementById("jolene-live-video");
                if (existingPlayer) existingPlayer.remove();

                const video = document.createElement("video");
                video.id = "jolene-live-video";
                video.srcObject = event.streams[0];
                video.autoplay = true;
                video.controls = true;
                video.playsInline = true;
                video.style = "width: 100%; max-width: 550px; margin-top: 15px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 10px 25px rgba(0,0,0,0.5); display: block;";
                
                // Mount player module directly underneath her text response wrapper frame
                chatMessages.appendChild(video);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            };
        } else {
            console.error("❌ Pipeline handshake rejected:", data.error);
            const errDiv = document.createElement("div");
            errDiv.style = "color: #ef4444; font-size: 0.8rem; margin-top: 8px; opacity: 0.85;";
            errDiv.innerText = `⚠️ Media Gateway Connection Warning: ${data.error || 'Check local hardware proxy configurations.'}`;
            chatMessages.appendChild(errDiv);
        }
    } catch (err) {
        console.error("❌ WebRTC Execution Engine Fault:", err);
    }
}

// --- CHAT LOGIC ---
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;
    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    typingIndicator?.classList.add("visible");
    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory, model: modelSelector?.value })
        });
        typingIndicator?.classList.remove("visible");

        // Intercept block check for specialized non-streaming JSON control objects (WebRTC Handshake Triggers)
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const controlData = await response.json();
            
            if (controlData.status === "WEBRTC_HANDSHAKE_REQUIRED") {
                // 1. Output her text response cleanly up to your desktop layout dashboard
                addMessageToChat("assistant", controlData.assistant_response);
                chatHistory.push({ role: "assistant", content: controlData.assistant_response });
                speak(controlData.assistant_response);
                
                // 2. Dispatch network handshake protocols to fire up video feed directly
                await executeWebRtcHandshake(controlData.camera, controlData.assistant_response);
                
                if (sidebar.classList.contains("open")) updateSidebarContent();
                return;
            }
        }

        // Standard Text Response Chunk Processing Flow (Main Lighting/Ambiance Streams)
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const msgEl = createMessageElement("assistant");
        chatMessages.appendChild(msgEl);
        const contentEl = msgEl.querySelector(".message-content");
        let text = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value).split("\n");
            for (const line of chunk) {
                if (line.startsWith("data: ")) {
                    const dataString = line.slice(6).trim();
                    if (dataString === "[DONE]") break;
                    try {
                        const json = JSON.parse(dataString);
                        text += json.response || "";
                        contentEl.innerHTML = marked.parse(text);
                    } catch (e) {}
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        chatHistory.push({ role: "assistant", content: text });
        speak(text);
        if (sidebar.classList.contains("open")) updateSidebarContent();
    } catch (err) { 
        addMessageToChat("assistant", "Error: " + err.message); 
    } finally { 
        isProcessing = false; 
        typingIndicator?.classList.remove("visible"); 
    }
}

function addMessageToChat(role, content) {
    const el = createMessageElement(role);
    el.querySelector(".message-content").innerHTML = marked.parse(content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
function createMessageElement(role) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `<div class="message-content"></div>`;
    return div;
}

// --- MEMORIZE ---
memorizeBtn?.addEventListener("click", async () => {
    let file = fileInput.files[0];
    if (!file) return alert("Pick a file first!");
    
    if (file.size > 10 * 1024 * 1024) {
        return alert("File is too large! Please keep it under 10MB.");
    }

    memorizeBtn.innerText = "Uploading to Brain...";
    memorizeBtn.disabled = true;
    typingIndicator?.classList.add("visible");

    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/api/memorize", { 
            method: "POST", 
            headers: { "x-session-id": sessionId }, 
            body: formData 
        });
        
        const data = await res.json();

        if (res.ok) {
            const feedbackText = `I've successfully memorized **${file.name}**.`;
            addMessageToChat("assistant", feedbackText);
            speak(feedbackText);
            fileInput.value = "";
            updateSidebarContent();
        } else {
            throw new Error(data.error || "Server error");
        }
    } catch (e) { 
        console.error("Memorize Error:", e);
        addMessageToChat("assistant", `Sorry, I hit a snag: ${e.message}`);
    } finally { 
        memorizeBtn.innerText = "Memorize File"; 
        memorizeBtn.disabled = false;
        typingIndicator?.classList.remove("visible");
    }
});

sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
toggleSidebarBtn?.addEventListener("click", () => { sidebar.classList.add("open"); updateSidebarContent(); });
closeSidebarBtn?.addEventListener("click", () => sidebar.classList.remove("open"));
newChatBtn?.addEventListener("click", () => { localStorage.removeItem("chatSessionId"); location.reload(); });
clearScreenBtn?.addEventListener("click", () => { chatMessages.innerHTML = ''; addMessageToChat('assistant', "Screen cleared!"); });

window.speechSynthesis.onvoiceschanged = () => synth.getVoices();

// --- INITIALIZATION ---
async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (res.ok) {
            const data = await res.json();
            const messages = data.messages || [];
            if (messages.length > 0) {
                chatMessages.innerHTML = ''; 
                chatHistory = messages;
                chatHistory.forEach(msg => addMessageToChat(msg.role, msg.content));
            }
        }

        const profileRes = await fetch('/api/profile', { headers: { 'x-session-id': sessionId } });
        if (profileRes.ok) {
            const data = await profileRes.json();
            document.body.classList.toggle("theme-fancy", data.theme === "fancy");
            
            if (chatHistory.length === 0 && data.messages && data.messages.length > 0) {
                chatMessages.innerHTML = '';
                chatHistory = data.messages;
                chatHistory.forEach(msg => addMessageToChat(msg.role, msg.content));
            }
            updateSidebarContent();
        }
    } catch (e) {
        console.error("Initialization failed:", e);
    }
}

init();
