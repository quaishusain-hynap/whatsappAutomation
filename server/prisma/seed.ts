import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      displayName: 'Administrator',
      passwordHash: await argon2.hash('vivi@12345'),
      role: 'admin',
    },
  });

  const account = await prisma.waAccount.findFirst();
  if (!account) {
    await prisma.waAccount.create({
      data: {
        name: 'MB Travels Primary',
        provider: 'baileys',
        status: 'disconnected',
        authDir: 'wa-auth/primary',
      },
    });
  }

  console.log(`Seeded admin user "${admin.username}" (password: admin123 — change it after first login) and primary WA account.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
