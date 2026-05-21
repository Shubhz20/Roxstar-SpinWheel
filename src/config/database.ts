import { PrismaClient } from "@prisma/client";

// Helper to fix unescaped special characters in database URLs
function fixDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const match = url.match(/^(postgres(?:ql)?:\/\/)([^:]+):(.*)$/);
    if (!match) return url;
    
    const [_, protocol, username, passwordAndHost] = match;
    if (!passwordAndHost) return url;
    
    const lastAtIndex = passwordAndHost.lastIndexOf('@');
    if (lastAtIndex === -1) return url;
    
    const rawPassword = passwordAndHost.substring(0, lastAtIndex);
    const hostAndDb = passwordAndHost.substring(lastAtIndex + 1);
    
    let safePassword = rawPassword;
    try {
      const decoded = decodeURIComponent(rawPassword);
      safePassword = encodeURIComponent(decoded);
    } catch (e) {
      safePassword = rawPassword.split('').map(char => {
        if (/[a-zA-Z0-9.\-_~]/.test(char)) {
          return char;
        }
        return encodeURIComponent(char);
      }).join('');
    }
    
    return `${protocol}${username}:${safePassword}@${hostAndDb}`;
  } catch (e) {
    console.error("Failed to fix database URL automatically:", e);
    return url;
  }
}

// Automatically fix environment variables before Prisma Client reads them
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = fixDatabaseUrl(process.env.DATABASE_URL);
}
if (process.env.DIRECT_URL) {
  process.env.DIRECT_URL = fixDatabaseUrl(process.env.DIRECT_URL);
}

// Singleton Prisma client to prevent multiple connections
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
