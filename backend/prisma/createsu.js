/*
 * Complete this script so that it is able to add a superuser to the database
 * Usage example: 
 *   node prisma/createsu.js clive123 clive.su@mail.utoronto.ca SuperUser123!
 */
'use strict';

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseArgs(argv) {
	const dashIndex = argv.indexOf('--');
	const raw = dashIndex >= 0 ? argv.slice(dashIndex + 1) : argv.slice(2);

	if (raw.length !== 2 && raw.length !== 3) {
		throw new Error('usage: node prisma/createsu.js <username> <email> <password>');
	}

	const emailIndex = raw.length === 3 ? 1 : 0;
	const passwordIndex = raw.length === 3 ? 2 : 1;

	return {
		email: String(raw[emailIndex]).trim().toLowerCase(),
		password: String(raw[passwordIndex]),
	};
}

async function main() {
	const { email, password } = parseArgs(process.argv);

	if (!email || !password) {
		throw new Error('invalid arguments');
	}

	const passwordHash = await bcrypt.hash(password, 10);

	const created = await prisma.account.upsert({
		where: { email },
		create: {
			role: 'admin',
			email,
			password_hash: passwordHash,
			activated: true,
			adminProfile: {
				create: {},
			},
		},
		update: {
			role: 'admin',
			password_hash: passwordHash,
			activated: true,
			adminProfile: {
				upsert: {
					create: {},
					update: {},
				},
			},
		},
		select: {
			id: true,
			email: true,
			role: true,
			activated: true,
		},
	});

	console.log(JSON.stringify(created));
}

main()
	.catch((err) => {
		console.error(err.message);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
