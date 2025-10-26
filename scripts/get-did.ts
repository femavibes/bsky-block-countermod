#!/usr/bin/env bun

/**
 * Simple script to get a DID from a handle
 * Usage: bun scripts/get-did.ts @username.bsky.social
 */

const handle = process.argv[2];

if (!handle) {
  console.error("Usage: bun scripts/get-did.ts @username.bsky.social");
  process.exit(1);
}

const cleanHandle = handle.replace("@", "");

try {
  const response = await fetch(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${cleanHandle}`);
  const data = await response.json();
  
  if (data.did) {
    console.log(`Handle: ${cleanHandle}`);
    console.log(`DID: ${data.did}`);
  } else {
    console.error("Could not resolve handle:", data);
  }
} catch (error) {
  console.error("Error resolving handle:", error);
}