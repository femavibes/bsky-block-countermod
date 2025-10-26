import { Agent } from "@atproto/api";
import "dotenv/config";

const LISTIFICATIONS_DID = "did:plc:ea2eqamjmtuo6f4rvhl3g6ne";

interface MonitorAccount {
  handle: string;
  password: string;
}

class BlockWatcher {
  private monitorAccounts: MonitorAccount[] = [];
  private blockersListUri: string = "";
  private listAgent?: Agent;

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    const monitorAccountsRaw = process.env.MONITOR_ACCOUNTS || "";
    this.monitorAccounts = monitorAccountsRaw
      .split(",")
      .filter(entry => entry.includes(":"))
      .map(entry => {
        const [handle, password] = entry.split(":");
        return { handle: handle.trim(), password: password.trim() };
      });

    this.blockersListUri = process.env.BLOCKERS_LIST_URI || "";
  }

  async start() {
    if (this.monitorAccounts.length === 0) {
      console.log("No monitor accounts configured");
      return;
    }

    if (!this.blockersListUri) {
      console.log("No BLOCKERS_LIST_URI configured");
      return;
    }

    // Create agent for managing the blockers list
    this.listAgent = new Agent({ service: "https://bsky.social" });
    await this.listAgent.login({
      identifier: process.env.LIST_ACCOUNT_HANDLE || "",
      password: process.env.LIST_ACCOUNT_PASSWORD || ""
    });

    console.log(`Block watcher monitoring ${this.monitorAccounts.length} accounts`);
    
    // Poll every 30 seconds
    setInterval(() => this.checkAllAccounts(), 30000);
    
    // Initial check
    await this.checkAllAccounts();
  }

  private async checkAllAccounts() {
    for (const account of this.monitorAccounts) {
      try {
        await this.checkAccount(account);
      } catch (error) {
        console.error(`Error checking ${account.handle}:`, error);
      }
    }
  }

  private async checkAccount(account: MonitorAccount) {
    const agent = new Agent({ service: "https://bsky.social" });
    await agent.login({ identifier: account.handle, password: account.password });

    try {
      // Try DMs first
      const convos = await agent.app.bsky.convo.listConvos({ limit: 10 });
      const listificationsConvo = convos.data.convos.find(
        convo => convo.members.some(member => member.did === LISTIFICATIONS_DID)
      );

      if (listificationsConvo) {
        const messages = await agent.app.bsky.convo.getMessages({
          convoId: listificationsConvo.id,
          limit: 20
        });

        for (const message of messages.data.messages) {
          if (message.sender.did === LISTIFICATIONS_DID) {
            await this.processNotification(message.text, account.handle);
          }
        }
      }
    } catch {
      // Fallback to mentions
      try {
        const notifications = await agent.app.bsky.notification.listNotifications({ limit: 50 });
        
        for (const notif of notifications.data.notifications) {
          if (notif.author.did === LISTIFICATIONS_DID && notif.reason === "mention") {
            const post = notif.record as any;
            if (post?.text) {
              await this.processNotification(post.text, account.handle);
            }
          }
        }
      } catch (error) {
        console.error(`Failed to check notifications for ${account.handle}:`, error);
      }
    }
  }

  private async processNotification(text: string, targetHandle: string) {
    const blockPattern = /@([\w.-]+)\s+has blocked you/i;
    const modListPattern = /@([\w.-]+)\s+has added you to the "[^"]*"\s+moderation list/i;
    
    const blockMatch = text.match(blockPattern);
    const modListMatch = text.match(modListPattern);
    
    if (!blockMatch && !modListMatch) {
      return;
    }
    
    const offenderHandle = blockMatch ? blockMatch[1] : modListMatch![1];
    const action = blockMatch ? "blocked" : "added to moderation list";
    
    try {
      // Resolve offender handle to DID
      const resolved = await this.listAgent!.com.atproto.identity.resolveHandle({ 
        handle: offenderHandle 
      });
      const offenderDid = resolved.data.did;
      
      console.log(`Detected: ${offenderHandle} (${offenderDid}) ${action} ${targetHandle}`);
      
      // Add to blockers list
      await this.addToBlockersList(offenderDid);
      
    } catch (error) {
      console.error(`Failed to resolve handle ${offenderHandle}:`, error);
    }
  }

  private async addToBlockersList(userDid: string) {
    if (!this.listAgent) return;
    
    try {
      await this.listAgent.app.bsky.graph.listitem.create(
        { repo: this.listAgent.did! },
        {
          subject: userDid,
          list: this.blockersListUri,
          createdAt: new Date().toISOString(),
        }
      );
      
      console.log(`Added ${userDid} to blockers list`);
    } catch (error) {
      console.error(`Failed to add ${userDid} to list:`, error);
    }
  }
}

const watcher = new BlockWatcher();
watcher.start().catch(console.error);