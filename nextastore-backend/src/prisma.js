const { PrismaClient } = require('@prisma/client');

// A single shared Prisma client for the whole process. Prisma manages its
// own connection pool internally — do not instantiate PrismaClient per
// request, and do not add your own pool on top of it.
const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn']
});

module.exports = prisma;
