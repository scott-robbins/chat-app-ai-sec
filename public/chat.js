// --- ADD TO TOP OF chat.js OR REPLACE FUNCTIONS ---

function toggleTheme() {
    const isFancy = document.body.classList.contains("theme-fancy");
    document.body.classList.remove("theme-fancy", "theme-plain");
    const newTheme = isFancy ? "plain" : "fancy";
    document.body.classList.add(`theme-${newTheme}`);
    localStorage.setItem("chatTheme", newTheme);
    addMessageToChat('assistant', `Theme switched to **${newTheme}** mode.`);
    document.getElementById('settings-dropdown').classList.remove('show');
}

function openSidebar() {
    document.getElementById("memory-sidebar").classList.add("open");
    updateSidebarContent();
    document.getElementById('settings-dropdown').classList.remove('show');
}

function openHelp() {
    document.getElementById("helpModal").style.display = "flex";
    document.getElementById('settings-dropdown').classList.remove('show');
}

function modelChanged() {
    const selector = document.getElementById("model-selector");
    const name = selector.options[selector.selectedIndex].text;
    addMessageToChat('assistant', `I am now using the **${name}** model.`);
    document.getElementById('settings-dropdown').classList.remove('show');
}

function clearScreen() {
    chatMessages.innerHTML = `<div class="message assistant-message"><div class="message-content"><p>Screen cleared! Ready for a fresh start.</p></div></div>`;
    chatHistory = [];
}

function newChat() {
    if(confirm("Start a new session?")) {
        localStorage.removeItem("chatSessionId");
        location.reload();
    }
}
