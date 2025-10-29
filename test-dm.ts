import { Bot } from "@skyware/bot";
import "dotenv/config";

async function testDMAccess() {
  const bot = new Bot();
  
  try {
    await bot.login({
      identifier: process.env.LIST_ACCOUNT_HANDLE || "",
      password: process.env.LIST_ACCOUNT_PASSWORD || ""
    });
    
    console.log("✓ Bot logged in successfully");
    
    // Try to access conversations
    try {
      const convos = await bot.agent.api.chat.bsky.convo.listConvos({ limit: 10 });
      console.log(`✓ Found ${convos.data.convos.length} conversations`);
      
      for (const convo of convos.data.convos) {
        console.log(`Conversation with: ${convo.members.map(m => m.handle || m.did).join(", ")}`);
        
        // Check for listifications
        const hasListifications = convo.members.some(m => 
          m.handle?.includes("listifications") || m.did === "did:plc:ea2eqamjmtuo6f4rvhl3g6ne"
        );
        
        if (hasListifications) {
          console.log("✓ Found listifications conversation!");
          
          const messages = await bot.agent.api.chat.bsky.convo.getMessages({
            convoId: convo.id,
            limit: 10
          });
          
          console.log(`Found ${messages.data.messages.length} messages`);
          for (const msg of messages.data.messages) {
            if (msg.sender.did !== bot.profile.did) {
              console.log(`Message: ${msg.text}`);
            }
          }
        }
      }
      
    } catch (error) {
      console.log("✗ DM API not available:", error.message);
    }
    
  } catch (error) {
    console.error("✗ Login failed:", error);
  }
}

testDMAccess();