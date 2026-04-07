// --- UPDATED: SAVE PROFILE (GLOBAL) ---
if (latestUserMessage.toLowerCase().startsWith("save to my profile:")) {
    const profileData = latestUserMessage.replace(/save to my profile:/i, "").trim();
    
    // Use a GLOBAL key instead of session-based
    await this.env.SETTINGS.put(`global_user_profile`, profileData);
    
    const successMsg = `Got it! I've added "${profileData}" to your permanent profile. I'll remember this in our future chats too!`;
    
    // Log to D1 normally
    await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .bind(sessionId, "user", latestUserMessage).run();
    await this.env.jolene_db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .bind(sessionId, "assistant", successMsg).run();

    return new Response(`data: ${JSON.stringify({ response: successMsg })}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" }
    });
}

// --- UPDATED: FETCH PROFILE (GLOBAL) ---
if (url.pathname === "/api/profile") {
    // Look for the Global key
    const profile = await this.env.SETTINGS.get(`global_user_profile`);
    
    const stats = await this.env.jolene_db.prepare(
        "SELECT COUNT(*) as count FROM messages WHERE session_id = ?"
    ).bind(sessionId).first();

    return new Response(JSON.stringify({ 
        profile: profile || "No global profile saved yet.",
        messageCount: stats?.count || 0 
    }), { 
        headers: { "Content-Type": "application/json" } 
    });
}
