/*
 * If you need to initialize your database with some data, you may write a script
 * to do so here.
 */
'use strict';

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PASSWORD = '123123';
const REGULAR_COUNT = 20;
const BUSINESS_COUNT = 10;
const ADMIN_COUNT = 1;

const POSITION_TYPES = [
	'Dental Assistant (Level 1)',
	'Dental Assistant (Level 2)',
	'Dental Hygienist',
	'Orthodontist',
	'Endodontist',
	'Periodontist',
	'Dental Receptionist',
	'Dental Office Manager',
	'Oral Surgeon',
	'Pediatric Dentist',
	'Dental Lab Technician',
	'Prosthodontist',
];

function pick(arr, index) {
	return arr[index % arr.length];
}

async function wipeDatabase() {
	await prisma.negotiationMessage.deleteMany();
	await prisma.negotiation.deleteMany();
	await prisma.interest.deleteMany();
	await prisma.job.deleteMany();
	await prisma.qualification.deleteMany();
	await prisma.positionType.deleteMany();
	await prisma.adminUser.deleteMany();
	await prisma.businessUser.deleteMany();
	await prisma.regularUser.deleteMany();
	await prisma.account.deleteMany();
}

async function seedAccounts(passwordHash) {
	const regularIds = [];
	const businessIds = [];
	const adminIds = [];

	for (let i = 1; i <= ADMIN_COUNT; i += 1) {
		const row = await prisma.account.create({
			data: {
				role: 'admin',
				email: `admin${i}@csc309.utoronto.ca`,
				password_hash: passwordHash,
				activated: true,
				adminProfile: {
					create: {},
				},
			},
			select: { id: true },
		});
		adminIds.push(row.id);
	}

	for (let i = 1; i <= REGULAR_COUNT; i += 1) {
		const row = await prisma.account.create({
			data: {
				role: 'regular',
				email: `regular${i}@csc309.utoronto.ca`,
				password_hash: passwordHash,
				activated: true,
				regularProfile: {
					create: {
						first_name: `Regular${i}`,
						last_name: `User${i}`,
						phone_number: `416-555-${String(1000 + i)}`,
						postal_address: `${i} College St, Toronto, ON`,
						birthday: `199${i % 10}-0${(i % 9) + 1}-1${i % 9}`,
						suspended: i % 11 === 0,
						available: i % 3 !== 0,
						last_active_at: new Date(Date.now() - (i % 7) * 60 * 1000),
						avatar: `/uploads/users/${i}/avatar.png`,
						resume: `/uploads/users/${i}/resume.pdf`,
						biography: `Regular user ${i} with flexible dental staffing experience.`,
					},
				},
			},
			select: { id: true },
		});
		regularIds.push(row.id);
	}

	for (let i = 1; i <= BUSINESS_COUNT; i += 1) {
		const row = await prisma.account.create({
			data: {
				role: 'business',
				email: `business${i}@csc309.utoronto.ca`,
				password_hash: passwordHash,
				activated: true,
				businessProfile: {
					create: {
						business_name: `Clinic ${i}`,
						owner_name: `Owner ${i}`,
						phone_number: `647-777-${String(2000 + i)}`,
						postal_address: `${100 + i} Bloor St, Toronto, ON`,
						location: {
							lon: -79.4 + i * 0.01,
							lat: 43.65 + i * 0.005,
						},
						verified: i <= 8,
						avatar: `/uploads/businesses/${i}/avatar.jpg`,
						biography: `Clinic ${i} provides patient-focused dental care and flexible shifts.`,
					},
				},
			},
			select: { id: true },
		});
		businessIds.push(row.id);
	}

	return { regularIds, businessIds, adminIds };
}

async function seedPositionTypes() {
	const ids = [];
	for (let i = 0; i < POSITION_TYPES.length; i += 1) {
		const row = await prisma.positionType.create({
			data: {
				name: POSITION_TYPES[i],
				description: `${POSITION_TYPES[i]} role description for staffing evaluation.`,
				hidden: i % 7 === 0,
			},
			select: { id: true },
		});
		ids.push(row.id);
	}
	return ids;
}

async function seedQualifications(regularIds, positionTypeIds) {
	const statuses = ['created', 'submitted', 'approved', 'rejected', 'revised'];
	const qualificationIds = [];

	for (let i = 0; i < regularIds.length; i += 1) {
		const userId = regularIds[i];
		const primaryTypeId = pick(positionTypeIds, i);
		const secondaryTypeId = pick(positionTypeIds, i + 3);

		const q1 = await prisma.qualification.create({
			data: {
				user_id: userId,
				position_type_id: primaryTypeId,
				status: pick(statuses, i),
				note: `Qualification note for regular user ${userId}.`,
				document: `/uploads/users/${userId}/position_type/${primaryTypeId}/document.pdf`,
			},
			select: { id: true },
		});
		qualificationIds.push(q1.id);

		if (i % 2 === 0) {
			const q2 = await prisma.qualification.create({
				data: {
					user_id: userId,
					position_type_id: secondaryTypeId,
					status: i % 4 === 0 ? 'approved' : 'submitted',
					note: `Secondary qualification for user ${userId}.`,
					document: `/uploads/users/${userId}/position_type/${secondaryTypeId}/document.pdf`,
				},
				select: { id: true },
			});
			qualificationIds.push(q2.id);
		}
	}

	return qualificationIds;
}

async function seedJobs(businessIds, regularIds, positionTypeIds) {
	const now = Date.now();
	const jobs = [];
	for (let i = 0; i < 30; i += 1) {
		const businessId = pick(businessIds, i);
		const positionTypeId = pick(positionTypeIds, i + 1);
		const workerId = pick(regularIds, i + 2);

		const start = new Date(now + (i - 8) * 4 * 60 * 60 * 1000);
		const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);

		let status = 'open';
		let assignedWorker = null;
		if (i % 10 === 0) {
			status = 'canceled';
			assignedWorker = workerId;
		} else if (i % 6 === 0) {
			status = 'completed';
			assignedWorker = workerId;
		} else if (i % 5 === 0) {
			status = 'filled';
			assignedWorker = workerId;
		} else if (i % 4 === 0) {
			status = 'expired';
		}

		const row = await prisma.job.create({
			data: {
				business_id: businessId,
				worker_id: assignedWorker,
				position_type_id: positionTypeId,
				status,
				note: `Shift ${i + 1} for ${pick(POSITION_TYPES, i)}.`,
				salary_min: 25 + (i % 8) * 2,
				salary_max: 35 + (i % 8) * 2,
				start_time: start,
				end_time: end,
			},
			select: {
				id: true,
				business_id: true,
				position_type_id: true,
				status: true,
			},
		});
		jobs.push(row);
	}
	return jobs;
}

async function seedInterestsAndNegotiations(jobs, regularIds) {
	const interestRows = [];

	const openJobs = jobs.filter((job) => job.status === 'open').slice(0, 15);
	for (let i = 0; i < openJobs.length; i += 1) {
		const job = openJobs[i];
		const candidateA = pick(regularIds, i);
		const candidateB = pick(regularIds, i + 5);

		const interestA = await prisma.interest.create({
			data: {
				job_id: job.id,
				candidate_id: candidateA,
				candidate_interested: true,
				business_interested: i % 2 === 0 ? true : null,
			},
		});
		interestRows.push(interestA);

		const interestB = await prisma.interest.create({
			data: {
				job_id: job.id,
				candidate_id: candidateB,
				candidate_interested: i % 3 === 0 ? true : null,
				business_interested: true,
			},
		});
		interestRows.push(interestB);
	}

	const now = Date.now();
	const activeSource = interestRows.find((it) => it.candidate_interested && it.business_interested);
	if (activeSource) {
		const active = await prisma.negotiation.create({
			data: {
				interest_id: activeSource.id,
				job_id: activeSource.job_id,
				candidate_id: activeSource.candidate_id,
				business_id: jobs.find((j) => j.id === activeSource.job_id).business_id,
				status: 'active',
				expiresAt: new Date(now + 10 * 60 * 1000),
			},
		});

		await prisma.negotiationMessage.createMany({
			data: [
				{
					negotiation_id: active.id,
					sender_role: 'business',
					sender_id: jobs.find((j) => j.id === activeSource.job_id).business_id,
					text: 'Can you confirm arrival 10 minutes early?',
				},
				{
					negotiation_id: active.id,
					sender_role: 'regular',
					sender_id: activeSource.candidate_id,
					text: 'Yes, I can arrive early.',
				},
			],
		});
	}

	const completedSources = interestRows.slice(1, 6).filter((it) => it.candidate_interested && it.business_interested);
	for (let i = 0; i < completedSources.length; i += 1) {
		const source = completedSources[i];
		const businessId = jobs.find((j) => j.id === source.job_id).business_id;
		await prisma.negotiation.create({
			data: {
				interest_id: source.id,
				job_id: source.job_id,
				candidate_id: source.candidate_id,
				business_id: businessId,
				status: i % 2 === 0 ? 'success' : 'failed',
				candidate_decision: i % 2 === 0 ? 'accept' : 'decline',
				business_decision: i % 2 === 0 ? 'accept' : 'accept',
				expiresAt: new Date(now - (i + 1) * 60 * 60 * 1000),
			},
		});
	}
}

async function main() {
	const passwordHash = await bcrypt.hash(PASSWORD, 10);
	await wipeDatabase();

	const { regularIds, businessIds } = await seedAccounts(passwordHash);
	const positionTypeIds = await seedPositionTypes();
	await seedQualifications(regularIds, positionTypeIds);
	const jobs = await seedJobs(businessIds, regularIds, positionTypeIds);
	await seedInterestsAndNegotiations(jobs, regularIds);

	console.log(`Seeded data with password ${PASSWORD}`);
	console.log(`regular users: ${REGULAR_COUNT}`);
	console.log(`businesses: ${BUSINESS_COUNT}`);
	console.log(`admins: ${ADMIN_COUNT}`);
	console.log(`position types: ${POSITION_TYPES.length}`);
	console.log('jobs: 30');
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
