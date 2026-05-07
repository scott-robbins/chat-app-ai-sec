async runAI(model: string, systemPrompt: string, userQuery: string, history: any[] = []) {
		// ... (keep your existing chatMessages setup)

		const accountId = this.env.CF_ACCOUNT_ID || this.env.ACCOUNT_ID;
		const gatewayBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${this.env.AI_GATEWAY_NAME || "ai-sec-gateway"}`;
		
		// ... (keep your existing url/headers/body setup)

		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

		// --- AI GATEWAY SECURITY HANDLER ---
		if (res.status === 424 || res.status === 403) {
			const errData: any = await res.json();
			const errString = JSON.stringify(errData);

			// 1. Handle DLP / Privacy Violations (The "Messy Response" fix)
			if (errString.includes("DLP policy violations") || errString.includes("sensitive_information") || errData.errors?.[0]?.code === 10037) {
				return "### 🛡️ Privacy Guardrail Triggered\n\nI'm sorry, Scott, but I've detected sensitive information (like a Social Security Number) in that request. To protect your privacy and comply with UVA and Cloudflare security policies, I've blocked this specific interaction. \n\nHow else can I assist you safely?";
			}

			// 2. Handle Prompt Injection Guardrails
			if (errString.includes("prompt_injection") || errString.includes("misuse") || errData.errors?.[0]?.code === 10038) {
				return "### ⚠️ Security Protocol: Identity Lock\n\nNice try, Scott! I've detected an attempt to bypass my core instructions or 'ignore previous commands.' My **Identity Lock** is active, and I am required to stay within my authorized persona and UVA safety guardrails. \n\nLet's get back to your Solution Engineering work or UVA materials!";
			}

			// Fallback for other blocks
			throw new Error(`Security Block (${res.status})`);
		}

		if (!res.ok) { 
			const errTxt = await res.text();
			throw new Error(`Gateway Error: ${res.status}`); 
		}
		
		const data: any = await res.json();
		
		if (model.startsWith("@cf/")) return data.result.response;
		if (model.toLowerCase().includes("claude")) return data.content[0].text;
		return data.choices[0].message.content;
	}
