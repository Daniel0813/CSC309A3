'use strict';

const express = require("express");
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { PrismaClient } = require('@prisma/client');
const { notifyNegotiationStarted } = require('./socket');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_TTL_SECONDS = 60 * 60 * 24;
const RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,20}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let resetCooldownSeconds = 60;
let negotiationWindowSeconds = 15 * 60;
let jobStartWindowHours = 7 * 24;
let availabilityTimeoutSeconds = 5 * 60;
const resetRequestByIp = new Map();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});

function sendError(res, status, message) {
    res.status(status).json({ error: message });
}

function parseBoolean(value) {
    if (value === true || value === false) {
        return value;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    return null;
}

function parsePositiveInt(value, defaultValue) {
    if (value === undefined) {
        return defaultValue;
    }
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function isAdmin(req) {
    return !!req.auth && req.auth.role === 'admin';
}

async function hasApprovedQualification(userId) {
    const count = await prisma.qualification.count({
        where: {
            user_id: userId,
            status: 'approved',
        },
    });
    return count > 0;
}

function computeEffectiveAvailability(user, nowMs) {
    if (!user.available) {
        return false;
    }
    if (user.suspended) {
        return false;
    }
    const lastActiveMs = new Date(user.last_active_at).getTime();
    return nowMs - lastActiveMs <= availabilityTimeoutSeconds * 1000;
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function extForMime(mime) {
    if (mime === 'image/png') {
        return '.png';
    }
    if (mime === 'image/jpeg') {
        return '.jpg';
    }
    if (mime === 'application/pdf') {
        return '.pdf';
    }
    return null;
}

function saveUpload(relativePath, fileBuffer) {
    const absolute = path.join(process.cwd(), relativePath.replace(/^\//, ''));
    ensureDir(path.dirname(absolute));
    fs.writeFileSync(absolute, fileBuffer);
}

function parseIsoDateTime(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const date = new Date(value);
    if (isNaN(date.getTime())) {
        return null;
    }
    return date;
}

function isValidLonLat(location) {
    if (!assertObject(location)) {
        return false;
    }
    if (typeof location.lon !== 'number' || typeof location.lat !== 'number') {
        return false;
    }
    if (location.lon < -180 || location.lon > 180) {
        return false;
    }
    if (location.lat < -90 || location.lat > 90) {
        return false;
    }
    return true;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371.2;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function isQualifiedForPosition(userId, positionTypeId) {
    const q = await prisma.qualification.findFirst({
        where: {
            user_id: userId,
            position_type_id: positionTypeId,
            status: 'approved',
        },
        select: { id: true },
    });
    return !!q;
}

async function hasConflictingCommitment(userId, startTime, endTime, nowMs) {
    const jobs = await prisma.job.findMany({
        where: {
            worker_id: userId,
            status: {
                in: ['filled', 'open', 'expired'],
            },
        },
        select: {
            start_time: true,
            end_time: true,
            status: true,
        },
    });

    const targetStart = new Date(startTime).getTime();
    const targetEnd = new Date(endTime).getTime();
    for (const job of jobs) {
        const effective = computeEffectiveJobStatus(job, nowMs);
        if (effective !== 'filled') {
            continue;
        }
        const existingStart = new Date(job.start_time).getTime();
        const existingEnd = new Date(job.end_time).getTime();
        const overlap = targetStart < existingEnd && existingStart < targetEnd;
        if (overlap) {
            return true;
        }
    }
    return false;
}

async function isDiscoverableForJob(userId, job, nowMs) {
    // Discoverability requires activation, availability, qualification, and no schedule overlap.
    const account = await prisma.account.findUnique({
        where: { id: userId },
        include: { regularProfile: true },
    });
    if (!account || account.role !== 'regular' || !account.regularProfile) {
        return false;
    }
    if (!account.activated || account.regularProfile.suspended) {
        return false;
    }
    if (!computeEffectiveAvailability(account.regularProfile, nowMs)) {
        return false;
    }

    const qualified = await isQualifiedForPosition(userId, job.position_type_id);
    if (!qualified) {
        return false;
    }

    const conflict = await hasConflictingCommitment(userId, job.start_time, job.end_time, nowMs);
    return !conflict;
}

async function getActiveNegotiationForAccount(accountId, role, nowMs) {
    const where = {
        status: 'active',
        expiresAt: {
            gt: new Date(nowMs),
        },
    };
    if (role === 'regular') {
        where.candidate_id = accountId;
    } else if (role === 'business') {
        where.business_id = accountId;
    } else {
        return null;
    }

    return prisma.negotiation.findFirst({
        where,
        include: {
            job: {
                include: {
                    positionType: true,
                    business: true,
                },
            },
            candidate: true,
            messages: {
                orderBy: {
                    createdAt: 'asc',
                },
            },
        },
        orderBy: {
            createdAt: 'desc',
        },
    });
}

function serializeNegotiation(negotiation) {
    return {
        id: negotiation.id,
        status: negotiation.status,
        createdAt: negotiation.createdAt,
        expiresAt: negotiation.expiresAt,
        updatedAt: negotiation.updatedAt,
        job: {
            id: negotiation.job.id,
            status: negotiation.job.status,
            position_type: {
                id: negotiation.job.positionType.id,
                name: negotiation.job.positionType.name,
            },
            business: {
                id: negotiation.job.business.account_id,
                business_name: negotiation.job.business.business_name,
            },
            salary_min: negotiation.job.salary_min,
            salary_max: negotiation.job.salary_max,
            start_time: negotiation.job.start_time,
            end_time: negotiation.job.end_time,
            updatedAt: negotiation.job.updatedAt,
        },
        user: {
            id: negotiation.candidate.account_id,
            first_name: negotiation.candidate.first_name,
            last_name: negotiation.candidate.last_name,
        },
        decisions: {
            candidate: negotiation.candidate_decision,
            business: negotiation.business_decision,
        },
        messages: (negotiation.messages || []).map((message) => ({
            id: message.id,
            sender: {
                role: message.sender_role,
                id: message.sender_id,
            },
            text: message.text,
            createdAt: message.createdAt,
        })),
    };
}

async function finalizeExpiredNegotiationsForAccount(accountId, role, nowMs) {
    const where = {
        status: 'active',
        expiresAt: {
            lte: new Date(nowMs),
        },
    };

    if (role === 'regular') {
        where.candidate_id = accountId;
    } else if (role === 'business') {
        where.business_id = accountId;
    } else {
        return;
    }

    const expiredRows = await prisma.negotiation.findMany({
        where,
        select: {
            id: true,
            candidate_id: true,
            interest_id: true,
        },
    });

    // Expiry is fainlizing lazily on r/w paths istead of through a background worker
    for (const row of expiredRows) {
        await prisma.$transaction(async (tx) => {
            await tx.negotiation.update({
                where: { id: row.id },
                data: { status: 'expired' },
            });

            await tx.interest.update({
                where: { id: row.interest_id },
                data: {
                    candidate_interested: null,
                    business_interested: null,
                },
            });

            await tx.regularUser.update({
                where: { account_id: row.candidate_id },
                data: {
                    available: true,
                    last_active_at: new Date(nowMs),
                },
            });
        });
    }
}

function computeEffectiveJobStatus(job, nowMs) {
    // statues is time-derived foor open/filled jobs so clientes see consstent current state
    if (job.status === 'canceled' || job.status === 'completed') {
        return job.status;
    }

    const startMs = new Date(job.start_time).getTime();
    const endMs = new Date(job.end_time).getTime();

    if (job.status === 'filled') {
        if (nowMs >= endMs) {
            return 'completed';
        }
        return 'filled';
    }

    if (job.status === 'expired') {
        return 'expired';
    }

    const latestNegotiationStartMs = startMs - negotiationWindowSeconds * 1000;
    if (nowMs >= latestNegotiationStartMs) {
        return 'expired';
    }

    return 'open';
}

async function hasActiveNegotiationForJob(jobId, nowMs) {
    const active = await prisma.negotiation.findFirst({
        where: {
            job_id: jobId,
            status: 'active',
            expiresAt: {
                gt: new Date(nowMs),
            },
        },
        select: { id: true },
    });
    return !!active;
}

function assertObject(payload) {
    return payload && typeof payload === 'object' && !Array.isArray(payload);
}

function validatePayload(payload, requiredFields, optionalFields) {
    if (!assertObject(payload)) {
        return 'payload must be an object';
    }

    const allowed = new Set([...requiredFields, ...optionalFields]);
    const keys = Object.keys(payload);
    for (const key of keys) {
        if (!allowed.has(key)) {
            return `unexpected field: ${key}`;
        }
    }

    for (const key of requiredFields) {
        if (!(key in payload)) {
            return `missing required field: ${key}`;
        }
    }

    return null;
}

function accountToTokenPayload(account) {
    return {
        sub: account.id,
        role: account.role,
    };
}

function authOptional(req, _res, next) {
    const header = req.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        req.auth = null;
        return next();
    }

    try {
        req.auth = jwt.verify(match[1], JWT_SECRET);
    } catch {
        req.auth = null;
    }
    next();
}

function requireAuth(req, res, next) {
    if (!req.auth || !req.auth.sub || !req.auth.role) {
        return sendError(res, 401, 'Unauthorized');
    }
    next();
}

function requireRole(roles) {
    return (req, res, next) => {
        if (!req.auth || !req.auth.role) {
            return sendError(res, 401, 'Unauthorized');
        }
        if (!roles.includes(req.auth.role)) {
            return sendError(res, 403, 'Forbidden');
        }
        next();
    };
}

async function issueResetTokenForAccount(accountId, nowMs) {
    const resetToken = uuidv4();
    const expiresAt = new Date(nowMs + RESET_TTL_MS);
    const account = await prisma.account.update({
        where: { id: accountId },
        data: {
            reset_token: resetToken,
            reset_expires: expiresAt,
            reset_used_at: null,
        },
        select: {
            reset_token: true,
            reset_expires: true,
        },
    });

    return {
        resetToken: account.reset_token,
        expiresAt: account.reset_expires,
    };
}

function create_app() {
    const app = express();
    app.use(cors({
        origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
    }));
    app.use(express.json());
    app.use(authOptional);

    const requireNumericPathParam = (paramName, allowValues = []) => {
        return (req, res, next) => {
            const raw = req.params[paramName];
            if (allowValues.includes(raw)) {
                return next();
            }
            // Router-level invalid IDs should surface as 404 before auth/validation checks.
            if (!/^\d+$/.test(String(raw))) {
                return sendError(res, 404, 'Not Found');
            }
            return next();
        };
    };

    app.use('/businesses/:businessId', requireNumericPathParam('businessId', ['me']));
    app.use('/position-types/:positionTypeId', requireNumericPathParam('positionTypeId'));
    app.use('/qualifications/:qualificationId', requireNumericPathParam('qualificationId'));
    app.use('/jobs/:jobId', requireNumericPathParam('jobId'));
    app.use('/jobs/:jobId/candidates/:userId', requireNumericPathParam('userId'));

    app.route('/users')
        .post(async (req, res) => {
            const err = validatePayload(
                req.body,
                ['first_name', 'last_name', 'email', 'password'],
                ['phone_number', 'postal_address', 'birthday']
            );
            if (err) {
                return sendError(res, 400, err);
            }

            const {
                first_name,
                last_name,
                email,
                password,
                phone_number = '',
                postal_address = '',
                birthday = '1970-01-01',
            } = req.body;

            if (
                typeof first_name !== 'string' ||
                typeof last_name !== 'string' ||
                typeof email !== 'string' ||
                typeof password !== 'string' ||
                typeof phone_number !== 'string' ||
                typeof postal_address !== 'string' ||
                typeof birthday !== 'string'
            ) {
                return sendError(res, 400, 'invalid field type');
            }

            const normalizedEmail = email.trim().toLowerCase();
            if (!EMAIL_RE.test(normalizedEmail)) {
                return sendError(res, 400, 'invalid email format');
            }

            if (!PASSWORD_RE.test(password)) {
                return sendError(res, 400, 'invalid password format');
            }

            if (!ISO_DATE_RE.test(birthday)) {
                return sendError(res, 400, 'invalid birthday');
            }

            const existing = await prisma.account.findUnique({ where: { email: normalizedEmail } });
            if (existing) {
                return sendError(res, 409, 'email already exists');
            }

            const passwordHash = await bcrypt.hash(password, 10);
            const nowMs = Date.now();

            const created = await prisma.account.create({
                data: {
                    role: 'regular',
                    email: normalizedEmail,
                    password_hash: passwordHash,
                    activated: false,
                    regularProfile: {
                        create: {
                            first_name,
                            last_name,
                            phone_number,
                            postal_address,
                            birthday,
                        },
                    },
                },
                include: {
                    regularProfile: true,
                },
            });

            const reset = await issueResetTokenForAccount(created.id, nowMs);

            return res.status(201).json({
                id: created.id,
                first_name: created.regularProfile.first_name,
                last_name: created.regularProfile.last_name,
                email: created.email,
                activated: created.activated,
                role: created.role,
                phone_number: created.regularProfile.phone_number,
                postal_address: created.regularProfile.postal_address,
                birthday: created.regularProfile.birthday,
                createdAt: created.createdAt,
                resetToken: reset.resetToken,
                expiresAt: reset.expiresAt,
            });
        })
        .get(requireAuth, requireRole(['admin']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const where = {
                role: 'regular',
            };

            if (req.query.keyword !== undefined) {
                if (typeof req.query.keyword !== 'string') {
                    return sendError(res, 400, 'invalid keyword');
                }
                const keyword = req.query.keyword.trim();
                where.OR = [
                    { regularProfile: { first_name: { contains: keyword } } },
                    { regularProfile: { last_name: { contains: keyword } } },
                    { email: { contains: keyword } },
                    { regularProfile: { postal_address: { contains: keyword } } },
                    { regularProfile: { phone_number: { contains: keyword } } },
                ];
            }

            if (req.query.activated !== undefined) {
                const activated = parseBoolean(req.query.activated);
                if (activated === null) {
                    return sendError(res, 400, 'invalid activated');
                }
                where.activated = activated;
            }

            if (req.query.suspended !== undefined) {
                const suspended = parseBoolean(req.query.suspended);
                if (suspended === null) {
                    return sendError(res, 400, 'invalid suspended');
                }
                where.regularProfile = {
                    ...(where.regularProfile || {}),
                    suspended,
                };
            }

            const [count, rows] = await prisma.$transaction([
                prisma.account.count({ where }),
                prisma.account.findMany({
                    where,
                    include: {
                        regularProfile: true,
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy: {
                        id: 'asc',
                    },
                }),
            ]);

            return res.status(200).json({
                count,
                results: rows.map((row) => ({
                    id: row.id,
                    first_name: row.regularProfile.first_name,
                    last_name: row.regularProfile.last_name,
                    email: row.email,
                    activated: row.activated,
                    suspended: row.regularProfile.suspended,
                    role: row.role,
                    phone_number: row.regularProfile.phone_number,
                    postal_address: row.regularProfile.postal_address,
                })),
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses')
        .post(async (req, res) => {
            const err = validatePayload(
                req.body,
                ['business_name', 'owner_name', 'email', 'password', 'phone_number', 'postal_address', 'location'],
                []
            );
            if (err) {
                return sendError(res, 400, err);
            }

            const {
                business_name,
                owner_name,
                email,
                password,
                phone_number,
                postal_address,
                location,
            } = req.body;

            if (
                typeof business_name !== 'string' ||
                typeof owner_name !== 'string' ||
                typeof email !== 'string' ||
                typeof password !== 'string' ||
                typeof phone_number !== 'string' ||
                typeof postal_address !== 'string' ||
                !assertObject(location)
            ) {
                return sendError(res, 400, 'invalid field type');
            }

            if (!isValidLonLat(location)) {
                return sendError(res, 400, 'invalid location');
            }

            const normalizedEmail = email.trim().toLowerCase();
            if (!EMAIL_RE.test(normalizedEmail)) {
                return sendError(res, 400, 'invalid email format');
            }

            if (!PASSWORD_RE.test(password)) {
                return sendError(res, 400, 'invalid password format');
            }

            const existing = await prisma.account.findUnique({ where: { email: normalizedEmail } });
            if (existing) {
                return sendError(res, 409, 'email already exists');
            }

            const passwordHash = await bcrypt.hash(password, 10);
            const nowMs = Date.now();

            const created = await prisma.account.create({
                data: {
                    role: 'business',
                    email: normalizedEmail,
                    password_hash: passwordHash,
                    activated: false,
                    businessProfile: {
                        create: {
                            business_name,
                            owner_name,
                            phone_number,
                            postal_address,
                            location,
                            verified: false,
                        },
                    },
                },
                include: {
                    businessProfile: true,
                },
            });

            const reset = await issueResetTokenForAccount(created.id, nowMs);

            return res.status(201).json({
                id: created.id,
                business_name: created.businessProfile.business_name,
                owner_name: created.businessProfile.owner_name,
                email: created.email,
                activated: created.activated,
                verified: created.businessProfile.verified,
                role: created.role,
                phone_number: created.businessProfile.phone_number,
                postal_address: created.businessProfile.postal_address,
                location: created.businessProfile.location,
                createdAt: created.createdAt,
                resetToken: reset.resetToken,
                expiresAt: reset.expiresAt,
            });
        })
        .get(async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const admin = isAdmin(req);
            const hasAdminOnlyFields =
                req.query.activated !== undefined ||
                req.query.verified !== undefined ||
                req.query.sort === 'owner_name';

            if (!admin && hasAdminOnlyFields) {
                return sendError(res, 400, 'admin-only fields require admin access');
            }

            const where = {
                role: 'business',
            };

            if (req.query.keyword !== undefined) {
                if (typeof req.query.keyword !== 'string') {
                    return sendError(res, 400, 'invalid keyword');
                }
                const keyword = req.query.keyword.trim();
                const keywordFilters = [
                    { businessProfile: { business_name: { contains: keyword } } },
                    { email: { contains: keyword } },
                    { businessProfile: { postal_address: { contains: keyword } } },
                    { businessProfile: { phone_number: { contains: keyword } } },
                ];
                if (admin) {
                    keywordFilters.push({ businessProfile: { owner_name: { contains: keyword } } });
                }
                where.OR = keywordFilters;
            }

            if (req.query.activated !== undefined) {
                const activated = parseBoolean(req.query.activated);
                if (activated === null) {
                    return sendError(res, 400, 'invalid activated');
                }
                where.activated = activated;
            }

            if (req.query.verified !== undefined) {
                const verified = parseBoolean(req.query.verified);
                if (verified === null) {
                    return sendError(res, 400, 'invalid verified');
                }
                where.businessProfile = {
                    ...(where.businessProfile || {}),
                    verified,
                };
            }

            const sort = req.query.sort;
            const order = req.query.order === 'desc' ? 'desc' : 'asc';

            if (sort !== undefined && typeof sort !== 'string') {
                return sendError(res, 400, 'invalid sort');
            }

            if (req.query.order !== undefined && req.query.order !== 'asc' && req.query.order !== 'desc') {
                return sendError(res, 400, 'invalid order');
            }

            let orderBy = { id: 'asc' };
            if (sort === 'business_name') {
                orderBy = { businessProfile: { business_name: order } };
            } else if (sort === 'email') {
                orderBy = { email: order };
            } else if (sort === 'owner_name') {
                if (!admin) {
                    return sendError(res, 400, 'invalid sort');
                }
                orderBy = { businessProfile: { owner_name: order } };
            } else if (sort !== undefined) {
                return sendError(res, 400, 'invalid sort');
            }

            const [count, rows] = await prisma.$transaction([
                prisma.account.count({ where }),
                prisma.account.findMany({
                    where,
                    include: {
                        businessProfile: true,
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                    orderBy,
                }),
            ]);

            return res.status(200).json({
                count,
                results: rows.map((row) => {
                    const base = {
                        id: row.id,
                        business_name: row.businessProfile.business_name,
                        email: row.email,
                        role: row.role,
                        phone_number: row.businessProfile.phone_number,
                        postal_address: row.businessProfile.postal_address,
                    };
                    if (admin) {
                        base.owner_name = row.businessProfile.owner_name;
                        base.verified = row.businessProfile.verified;
                        base.activated = row.activated;
                    }
                    return base;
                }),
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/:businessId')
        .get(async (req, res, next) => {
            if (req.params.businessId === 'me') {
                return next();
            }

            const businessId = parseInt(req.params.businessId, 10);
            if (isNaN(businessId)) {
                return sendError(res, 400, 'invalid businessId');
            }

            const row = await prisma.account.findFirst({
                where: {
                    id: businessId,
                    role: 'business',
                },
                include: {
                    businessProfile: true,
                },
            });

            if (!row) {
                return sendError(res, 404, 'Not Found');
            }

            const admin = isAdmin(req);
            const payload = {
                id: row.id,
                business_name: row.businessProfile.business_name,
                email: row.email,
                role: row.role,
                phone_number: row.businessProfile.phone_number,
                postal_address: row.businessProfile.postal_address,
                location: row.businessProfile.location,
                avatar: row.businessProfile.avatar,
                biography: row.businessProfile.biography,
            };
            if (admin) {
                payload.owner_name = row.businessProfile.owner_name;
                payload.activated = row.activated;
                payload.verified = row.businessProfile.verified;
                payload.createdAt = row.createdAt;
            }

            return res.status(200).json(payload);
        })
        .all((req, res, next) => {
            if (req.params.businessId === 'me') {
                return next();
            }
            return sendError(res, 405, 'Method Not Allowed');
        });

    app.route('/users/:userId/suspended')
        .patch(requireAuth, requireRole(['admin']), async (req, res) => {
            const userId = parseInt(req.params.userId, 10);
            if (isNaN(userId)) {
                return sendError(res, 400, 'invalid userId');
            }

            const err = validatePayload(req.body, ['suspended'], []);
            if (err) {
                return sendError(res, 400, err);
            }

            if (typeof req.body.suspended !== 'boolean') {
                return sendError(res, 400, 'invalid suspended');
            }

            const user = await prisma.account.findFirst({
                where: {
                    id: userId,
                    role: 'regular',
                },
                include: {
                    regularProfile: true,
                },
            });

            if (!user) {
                return sendError(res, 404, 'Not Found');
            }

            const updated = await prisma.regularUser.update({
                where: {
                    account_id: userId,
                },
                data: {
                    suspended: req.body.suspended,
                },
            });

            return res.status(200).json({
                id: user.id,
                first_name: user.regularProfile.first_name,
                last_name: user.regularProfile.last_name,
                email: user.email,
                activated: user.activated,
                suspended: updated.suspended,
                role: user.role,
                phone_number: user.regularProfile.phone_number,
                postal_address: user.regularProfile.postal_address,
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/:businessId/verified')
        .patch(requireAuth, requireRole(['admin']), async (req, res) => {
            const businessId = parseInt(req.params.businessId, 10);
            if (isNaN(businessId)) {
                return sendError(res, 400, 'invalid businessId');
            }

            const err = validatePayload(req.body, ['verified'], []);
            if (err) {
                return sendError(res, 400, err);
            }

            if (typeof req.body.verified !== 'boolean') {
                return sendError(res, 400, 'invalid verified');
            }

            const business = await prisma.account.findFirst({
                where: {
                    id: businessId,
                    role: 'business',
                },
                include: {
                    businessProfile: true,
                },
            });

            if (!business) {
                return sendError(res, 404, 'Not Found');
            }

            const updated = await prisma.businessUser.update({
                where: {
                    account_id: businessId,
                },
                data: {
                    verified: req.body.verified,
                },
            });

            return res.status(200).json({
                id: business.id,
                business_name: business.businessProfile.business_name,
                owner_name: business.businessProfile.owner_name,
                email: business.email,
                activated: business.activated,
                verified: updated.verified,
                role: business.role,
                phone_number: business.businessProfile.phone_number,
                postal_address: business.businessProfile.postal_address,
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/auth/resets')
        .post(async (req, res) => {
            const err = validatePayload(req.body, ['email'], []);
            if (err) {
                return sendError(res, 400, err);
            }

            if (typeof req.body.email !== 'string') {
                return sendError(res, 400, 'invalid field type');
            }

            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            const nowMs = Date.now();
            const lastMs = resetRequestByIp.get(ip);
            if (typeof lastMs === 'number' && nowMs - lastMs < resetCooldownSeconds * 1000) {
                return sendError(res, 429, 'Too Many Requests');
            }

            const email = req.body.email.trim().toLowerCase();
            const account = await prisma.account.findUnique({ where: { email } });
            if (!account) {
                return sendError(res, 404, 'Not Found');
            }

            resetRequestByIp.set(ip, nowMs);
            const reset = await issueResetTokenForAccount(account.id, nowMs);
            return res.status(202).json(reset);
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/auth/resets/:resetToken')
        .post(async (req, res) => {
            const err = validatePayload(req.body, ['email'], ['password']);
            if (err) {
                return sendError(res, 400, err);
            }

            if (typeof req.body.email !== 'string') {
                return sendError(res, 400, 'invalid field type');
            }

            if ('password' in req.body && typeof req.body.password !== 'string') {
                return sendError(res, 400, 'invalid field type');
            }

            if ('password' in req.body && !PASSWORD_RE.test(req.body.password)) {
                return sendError(res, 400, 'invalid password format');
            }

            const token = req.params.resetToken;
            const now = new Date();

            const account = await prisma.account.findFirst({
                where: {
                    reset_token: token,
                    reset_used_at: null,
                },
            });

            if (!account) {
                return sendError(res, 401, 'Unauthorized');
            }

            if (!account.reset_expires || account.reset_expires.getTime() < now.getTime()) {
                return sendError(res, 410, 'Gone');
            }

            const email = req.body.email.trim().toLowerCase();
            if (account.email !== email) {
                return sendError(res, 401, 'Unauthorized');
            }

            const updateData = {
                reset_used_at: now,
                activated: true,
            };

            if (req.body.password) {
                updateData.password_hash = await bcrypt.hash(req.body.password, 10);
            }

            await prisma.account.update({
                where: { id: account.id },
                data: updateData,
            });

            return res.status(200).json({ activated: true });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/auth/tokens')
        .post(async (req, res) => {
            const err = validatePayload(req.body, ['email', 'password'], []);
            if (err) {
                return sendError(res, 400, err);
            }

            if (typeof req.body.email !== 'string' || typeof req.body.password !== 'string') {
                return sendError(res, 400, 'invalid field type');
            }

            const email = req.body.email.trim().toLowerCase();
            const account = await prisma.account.findUnique({ where: { email } });
            if (!account) {
                return sendError(res, 401, 'Unauthorized');
            }

            const ok = await bcrypt.compare(req.body.password, account.password_hash);
            if (!ok) {
                return sendError(res, 401, 'Unauthorized');
            }

            if (!account.activated) {
                return sendError(res, 403, 'Forbidden');
            }

            const expiresAt = new Date(Date.now() + JWT_TTL_SECONDS * 1000);
            const token = jwt.sign(accountToTokenPayload(account), JWT_SECRET, {
                expiresIn: JWT_TTL_SECONDS,
            });

            return res.status(200).json({ token, expiresAt });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/position-types')
        .post(requireAuth, requireRole(['admin']), async (req, res) => {
            const err = validatePayload(req.body, ['name', 'description'], ['hidden']);
            if (err) {
                return sendError(res, 400, err);
            }

            const { name, description } = req.body;
            const hidden = req.body.hidden === undefined ? true : req.body.hidden;

            if (typeof name !== 'string' || typeof description !== 'string' || typeof hidden !== 'boolean') {
                return sendError(res, 400, 'invalid field type');
            }

            try {
                const created = await prisma.positionType.create({
                    data: {
                        name,
                        description,
                        hidden,
                    },
                });

                return res.status(201).json({
                    id: created.id,
                    name: created.name,
                    description: created.description,
                    hidden: created.hidden,
                    num_qualified: 0,
                });
            } catch {
                return sendError(res, 409, 'name already exists');
            }
        })
        .get(requireAuth, requireRole(['regular', 'business', 'admin']), async (req, res) => {
            const admin = isAdmin(req);
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            if (!admin && (req.query.hidden !== undefined || req.query.num_qualified !== undefined)) {
                return sendError(res, 403, 'Forbidden');
            }

            const where = {};
            if (!admin) {
                where.hidden = false;
            }

            if (req.query.hidden !== undefined) {
                const hidden = parseBoolean(req.query.hidden);
                if (hidden === null) {
                    return sendError(res, 400, 'invalid hidden');
                }
                where.hidden = hidden;
            }

            if (req.query.keyword !== undefined) {
                if (typeof req.query.keyword !== 'string') {
                    return sendError(res, 400, 'invalid keyword');
                }
                const keyword = req.query.keyword.trim();
                where.OR = [
                    { name: { contains: keyword } },
                    { description: { contains: keyword } },
                ];
            }

            if (req.query.name !== undefined && req.query.name !== 'asc' && req.query.name !== 'desc') {
                return sendError(res, 400, 'invalid name sort');
            }

            if (
                req.query.num_qualified !== undefined &&
                req.query.num_qualified !== 'asc' &&
                req.query.num_qualified !== 'desc'
            ) {
                return sendError(res, 400, 'invalid num_qualified sort');
            }

            const rows = await prisma.positionType.findMany({
                where,
                include: {
                    qualifications: {
                        where: {
                            status: 'approved',
                        },
                        select: {
                            user_id: true,
                        },
                    },
                },
            });

            const withCounts = rows.map((row) => {
                const uniqueUsers = new Set(row.qualifications.map((q) => q.user_id));
                return {
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    hidden: row.hidden,
                    num_qualified: uniqueUsers.size,
                };
            });

            if (admin) {
                const nqDir = req.query.num_qualified || 'asc';
                const nameDir = req.query.name || 'asc';
                withCounts.sort((a, b) => {
                    const byNq = nqDir === 'asc' ? a.num_qualified - b.num_qualified : b.num_qualified - a.num_qualified;
                    if (byNq !== 0) {
                        return byNq;
                    }
                    return nameDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
                });
            } else {
                const nameDir = req.query.name || 'asc';
                withCounts.sort((a, b) =>
                    nameDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
                );
            }

            const total = withCounts.length;
            const paged = withCounts.slice((page - 1) * limit, page * limit);

            return res.status(200).json({
                count: total,
                results: paged.map((row) => {
                    if (admin) {
                        return row;
                    }
                    return {
                        id: row.id,
                        name: row.name,
                        description: row.description,
                    };
                }),
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/position-types/:positionTypeId')
        .patch(requireAuth, requireRole(['admin']), async (req, res) => {
            const positionTypeId = parseInt(req.params.positionTypeId, 10);
            if (isNaN(positionTypeId)) {
                return sendError(res, 400, 'invalid positionTypeId');
            }

            const err = validatePayload(req.body, [], ['name', 'description', 'hidden']);
            if (err) {
                return sendError(res, 400, err);
            }

            const keys = Object.keys(req.body);
            if (keys.length === 0) {
                return sendError(res, 400, 'no fields to update');
            }

            if (req.body.name !== undefined && typeof req.body.name !== 'string') {
                return sendError(res, 400, 'invalid name');
            }
            if (req.body.description !== undefined && typeof req.body.description !== 'string') {
                return sendError(res, 400, 'invalid description');
            }
            if (req.body.hidden !== undefined && typeof req.body.hidden !== 'boolean') {
                return sendError(res, 400, 'invalid hidden');
            }

            try {
                const updated = await prisma.positionType.update({
                    where: { id: positionTypeId },
                    data: req.body,
                });

                const response = { id: updated.id };
                for (const key of keys) {
                    response[key] = updated[key];
                }
                return res.status(200).json(response);
            } catch {
                return sendError(res, 404, 'Not Found');
            }
        })
        .delete(requireAuth, requireRole(['admin']), async (req, res) => {
            const positionTypeId = parseInt(req.params.positionTypeId, 10);
            if (isNaN(positionTypeId)) {
                return sendError(res, 400, 'invalid positionTypeId');
            }

            const pt = await prisma.positionType.findUnique({
                where: { id: positionTypeId },
                include: {
                    qualifications: {
                        where: {
                            status: 'approved',
                        },
                        select: {
                            user_id: true,
                        },
                    },
                },
            });

            if (!pt) {
                return sendError(res, 404, 'Not Found');
            }

            const uniqueApprovedUsers = new Set(pt.qualifications.map((q) => q.user_id));
            if (uniqueApprovedUsers.size > 0) {
                return sendError(res, 409, 'position type has qualified users');
            }

            await prisma.positionType.delete({
                where: { id: positionTypeId },
            });
            return res.status(204).send();
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/qualifications')
        .get(requireAuth, requireRole(['admin']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const where = {
                status: {
                    in: ['submitted', 'revised'],
                },
            };

            if (req.query.keyword !== undefined) {
                if (typeof req.query.keyword !== 'string') {
                    return sendError(res, 400, 'invalid keyword');
                }
                const keyword = req.query.keyword.trim();
                where.user = {
                    OR: [
                        { first_name: { contains: keyword } },
                        { last_name: { contains: keyword } },
                        { account: { email: { contains: keyword } } },
                        { phone_number: { contains: keyword } },
                    ],
                };
            }

            const [count, rows] = await prisma.$transaction([
                prisma.qualification.count({ where }),
                prisma.qualification.findMany({
                    where,
                    include: {
                        user: true,
                        positionType: true,
                    },
                    orderBy: {
                        updatedAt: 'desc',
                    },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
            ]);

            return res.status(200).json({
                count,
                results: rows.map((row) => ({
                    id: row.id,
                    status: row.status,
                    user: {
                        id: row.user.account_id,
                        first_name: row.user.first_name,
                        last_name: row.user.last_name,
                    },
                    position_type: {
                        id: row.positionType.id,
                        name: row.positionType.name,
                    },
                    updatedAt: row.updatedAt,
                })),
            });
        })
        .post(requireAuth, requireRole(['regular']), async (req, res) => {
            const err = validatePayload(req.body, ['position_type_id'], ['note']);
            if (err) {
                return sendError(res, 400, err);
            }

            const positionTypeId = req.body.position_type_id;
            const note = req.body.note === undefined ? '' : req.body.note;

            if (typeof positionTypeId !== 'number' || !Number.isInteger(positionTypeId) || typeof note !== 'string') {
                return sendError(res, 400, 'invalid field type');
            }

            const pt = await prisma.positionType.findFirst({
                where: {
                    id: positionTypeId,
                    hidden: false,
                },
            });
            if (!pt) {
                return sendError(res, 404, 'Not Found');
            }

            try {
                const created = await prisma.qualification.create({
                    data: {
                        user_id: req.auth.sub,
                        position_type_id: positionTypeId,
                        note,
                        status: 'created',
                    },
                    include: {
                        user: true,
                        positionType: true,
                    },
                });

                return res.status(201).json({
                    id: created.id,
                    status: created.status,
                    note: created.note,
                    document: created.document,
                    user: {
                        id: created.user.account_id,
                        first_name: created.user.first_name,
                        last_name: created.user.last_name,
                    },
                    position_type: {
                        id: created.positionType.id,
                        name: created.positionType.name,
                    },
                    updatedAt: created.updatedAt,
                });
            } catch {
                return sendError(res, 409, 'qualification already exists');
            }
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/qualifications/:qualificationId')
        .get(requireAuth, requireRole(['admin', 'regular', 'business']), async (req, res) => {
            const qualificationId = parseInt(req.params.qualificationId, 10);
            if (isNaN(qualificationId)) {
                return sendError(res, 400, 'invalid qualificationId');
            }

            const q = await prisma.qualification.findUnique({
                where: { id: qualificationId },
                include: {
                    positionType: true,
                    user: {
                        include: {
                            account: true,
                        },
                    },
                },
            });
            if (!q) {
                return sendError(res, 404, 'Not Found');
            }

            const role = req.auth.role;

            if (role === 'regular' && q.user_id !== req.auth.sub) {
                return sendError(res, 404, 'Not Found');
            }

            if (role === 'business') {
                if (q.status !== 'approved') {
                    return sendError(res, 403, 'Forbidden');
                }

                const eligibleInterest = await prisma.interest.findFirst({
                    where: {
                        candidate_id: q.user_id,
                        job: {
                            business_id: req.auth.sub,
                            status: 'open',
                            position_type_id: q.position_type_id,
                        },
                    },
                });

                if (!eligibleInterest) {
                    return sendError(res, 403, 'Forbidden');
                }
            }

            const base = {
                id: q.id,
                document: q.document,
                note: q.note,
                position_type: {
                    id: q.positionType.id,
                    name: q.positionType.name,
                    description: q.positionType.description,
                },
                updatedAt: q.updatedAt,
                user: {
                    id: q.user.account_id,
                    first_name: q.user.first_name,
                    last_name: q.user.last_name,
                    role: 'regular',
                    avatar: q.user.avatar,
                    resume: q.user.resume,
                    biography: q.user.biography,
                },
            };

            if (role !== 'business') {
                base.user.email = q.user.account.email;
                base.user.phone_number = q.user.phone_number;
                base.user.postal_address = q.user.postal_address;
                base.user.birthday = q.user.birthday;
                base.user.activated = q.user.account.activated;
                base.user.suspended = q.user.suspended;
                base.user.createdAt = q.user.account.createdAt;
                base.status = q.status;
            }

            return res.status(200).json(base);
        })
        .patch(requireAuth, requireRole(['admin', 'regular']), async (req, res) => {
            const qualificationId = parseInt(req.params.qualificationId, 10);
            if (isNaN(qualificationId)) {
                return sendError(res, 400, 'invalid qualificationId');
            }

            const err = validatePayload(req.body, [], ['status', 'note']);
            if (err) {
                return sendError(res, 400, err);
            }

            if (Object.keys(req.body).length === 0) {
                return sendError(res, 400, 'no fields to update');
            }

            if (req.body.status !== undefined && typeof req.body.status !== 'string') {
                return sendError(res, 400, 'invalid status');
            }

            if (req.body.note !== undefined && typeof req.body.note !== 'string') {
                return sendError(res, 400, 'invalid note');
            }

            const q = await prisma.qualification.findUnique({
                where: { id: qualificationId },
                include: {
                    user: true,
                    positionType: true,
                },
            });

            if (!q) {
                return sendError(res, 404, 'Not Found');
            }

            const role = req.auth.role;
            if (role === 'regular' && q.user_id !== req.auth.sub) {
                return sendError(res, 403, 'Forbidden');
            }

            if (req.body.status !== undefined) {
                const nextStatus = req.body.status;
                const currentStatus = q.status;

                if (role === 'admin') {
                    const allowedCurrent = ['submitted', 'revised'];
                    const allowedNext = ['approved', 'rejected'];
                    if (!allowedCurrent.includes(currentStatus) || !allowedNext.includes(nextStatus)) {
                        return sendError(res, 403, 'Forbidden');
                    }
                }

                if (role === 'regular') {
                    const validTransition =
                        (currentStatus === 'created' && nextStatus === 'submitted') ||
                        ((currentStatus === 'approved' || currentStatus === 'rejected') && nextStatus === 'revised');
                    if (!validTransition) {
                        return sendError(res, 403, 'Forbidden');
                    }
                }
            }

            const updated = await prisma.qualification.update({
                where: { id: qualificationId },
                data: req.body,
                include: {
                    user: true,
                    positionType: true,
                },
            });

            return res.status(200).json({
                id: updated.id,
                status: updated.status,
                document: updated.document,
                note: updated.note,
                user: {
                    id: updated.user.account_id,
                    first_name: updated.user.first_name,
                    last_name: updated.user.last_name,
                },
                position_type: {
                    id: updated.positionType.id,
                    name: updated.positionType.name,
                },
                updatedAt: updated.updatedAt,
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.get('/healthz', (_req, res) => {
        res.status(200).json({ ok: true });
    });

    app.patch('/system/reset-cooldown', requireAuth, requireRole(['admin']), (req, res) => {
        const err = validatePayload(req.body, ['reset_cooldown'], []);
        if (err) {
            return sendError(res, 400, err);
        }

        if (typeof req.body.reset_cooldown !== 'number' || req.body.reset_cooldown < 0) {
            return sendError(res, 400, 'invalid reset_cooldown');
        }

        resetCooldownSeconds = req.body.reset_cooldown;
        return res.status(200).json({ reset_cooldown: resetCooldownSeconds });
    });

    app.patch('/system/negotiation-window', requireAuth, requireRole(['admin']), (req, res) => {
        const err = validatePayload(req.body, ['negotiation_window'], []);
        if (err) {
            return sendError(res, 400, err);
        }
        if (typeof req.body.negotiation_window !== 'number' || req.body.negotiation_window <= 0) {
            return sendError(res, 400, 'invalid negotiation_window');
        }
        negotiationWindowSeconds = req.body.negotiation_window;
        return res.status(200).json({ negotiation_window: negotiationWindowSeconds });
    });

    app.patch('/system/job-start-window', requireAuth, requireRole(['admin']), (req, res) => {
        const err = validatePayload(req.body, ['job_start_window'], []);
        if (err) {
            return sendError(res, 400, err);
        }
        if (typeof req.body.job_start_window !== 'number' || req.body.job_start_window <= 0) {
            return sendError(res, 400, 'invalid job_start_window');
        }
        jobStartWindowHours = req.body.job_start_window;
        return res.status(200).json({ job_start_window: jobStartWindowHours });
    });

    app.patch('/system/availability-timeout', requireAuth, requireRole(['admin']), (req, res) => {
        const err = validatePayload(req.body, ['availability_timeout'], []);
        if (err) {
            return sendError(res, 400, err);
        }
        if (typeof req.body.availability_timeout !== 'number' || req.body.availability_timeout <= 0) {
            return sendError(res, 400, 'invalid availability_timeout');
        }
        availabilityTimeoutSeconds = req.body.availability_timeout;
        return res.status(200).json({ availability_timeout: availabilityTimeoutSeconds });
    });

    app.route('/users/me')
        .get(requireAuth, requireRole(['regular']), async (req, res) => {
            const account = await prisma.account.findUnique({
                where: { id: req.auth.sub },
                include: {
                    regularProfile: true,
                },
            });
            if (!account || !account.regularProfile) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveAvailable = computeEffectiveAvailability(account.regularProfile, nowMs);

            return res.status(200).json({
                id: account.id,
                first_name: account.regularProfile.first_name,
                last_name: account.regularProfile.last_name,
                email: account.email,
                activated: account.activated,
                suspended: account.regularProfile.suspended,
                available: effectiveAvailable,
                role: account.role,
                phone_number: account.regularProfile.phone_number,
                postal_address: account.regularProfile.postal_address,
                birthday: account.regularProfile.birthday,
                createdAt: account.createdAt,
                avatar: account.regularProfile.avatar,
                resume: account.regularProfile.resume,
                biography: account.regularProfile.biography,
            });
        })
        .patch(requireAuth, requireRole(['regular']), async (req, res) => {
            const err = validatePayload(req.body, [], [
                'first_name',
                'last_name',
                'phone_number',
                'postal_address',
                'birthday',
                'avatar',
                'biography',
            ]);
            if (err) {
                return sendError(res, 400, err);
            }

            const keys = Object.keys(req.body);
            if (keys.length === 0) {
                return sendError(res, 400, 'no fields to update');
            }

            if (req.body.birthday !== undefined) {
                if (typeof req.body.birthday !== 'string' || !ISO_DATE_RE.test(req.body.birthday)) {
                    return sendError(res, 400, 'invalid birthday');
                }
            }

            const stringOrNullFields = new Set(['avatar']);
            for (const key of keys) {
                const value = req.body[key];
                if (stringOrNullFields.has(key)) {
                    if (!(typeof value === 'string' || value === null)) {
                        return sendError(res, 400, `invalid ${key}`);
                    }
                } else if (typeof value !== 'string') {
                    return sendError(res, 400, `invalid ${key}`);
                }
            }

            const updated = await prisma.regularUser.update({
                where: {
                    account_id: req.auth.sub,
                },
                data: req.body,
            });

            const payload = { id: req.auth.sub };
            // Return only fields requested by the patch body (plus id for client correlation).
            for (const key of keys) {
                payload[key] = updated[key];
            }
            return res.status(200).json(payload);
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.patch('/users/me/available', requireAuth, requireRole(['regular']), async (req, res) => {
        const err = validatePayload(req.body, ['available'], []);
        if (err) {
            return sendError(res, 400, err);
        }
        if (typeof req.body.available !== 'boolean') {
            return sendError(res, 400, 'invalid available');
        }

        const user = await prisma.regularUser.findUnique({
            where: { account_id: req.auth.sub },
        });
        if (!user) {
            return sendError(res, 404, 'Not Found');
        }

        if (req.body.available) {
            if (user.suspended) {
                return sendError(res, 400, 'suspended users cannot be available');
            }
            const approved = await hasApprovedQualification(req.auth.sub);
            if (!approved) {
                return sendError(res, 400, 'approved qualification required');
            }
        }

        const updated = await prisma.regularUser.update({
            where: {
                account_id: req.auth.sub,
            },
            data: {
                available: req.body.available,
                ...(req.body.available ? { last_active_at: new Date() } : {}),
            },
        });

        return res.status(200).json({ available: updated.available });
    });

    app.all('/users/me/available', (_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/me')
        .get(requireAuth, requireRole(['business']), async (req, res) => {
            const account = await prisma.account.findUnique({
                where: { id: req.auth.sub },
                include: {
                    businessProfile: true,
                },
            });

            if (!account || !account.businessProfile) {
                return sendError(res, 404, 'Not Found');
            }

            return res.status(200).json({
                id: account.id,
                business_name: account.businessProfile.business_name,
                owner_name: account.businessProfile.owner_name,
                email: account.email,
                role: account.role,
                phone_number: account.businessProfile.phone_number,
                postal_address: account.businessProfile.postal_address,
                location: account.businessProfile.location,
                avatar: account.businessProfile.avatar,
                biography: account.businessProfile.biography,
                activated: account.activated,
                verified: account.businessProfile.verified,
                createdAt: account.createdAt,
            });
        })
        .patch(requireAuth, requireRole(['business']), async (req, res) => {
            const err = validatePayload(req.body, [], [
                'business_name',
                'owner_name',
                'phone_number',
                'postal_address',
                'location',
                'avatar',
                'biography',
            ]);
            if (err) {
                return sendError(res, 400, err);
            }

            const keys = Object.keys(req.body);
            if (keys.length === 0) {
                return sendError(res, 400, 'no fields to update');
            }

            for (const key of ['business_name', 'owner_name', 'phone_number', 'postal_address', 'biography']) {
                if (req.body[key] !== undefined && typeof req.body[key] !== 'string') {
                    return sendError(res, 400, `invalid ${key}`);
                }
            }

            if (req.body.avatar !== undefined && !(typeof req.body.avatar === 'string' || req.body.avatar === null)) {
                return sendError(res, 400, 'invalid avatar');
            }

            if (req.body.location !== undefined) {
                if (!isValidLonLat(req.body.location)) {
                    return sendError(res, 400, 'invalid location');
                }
            }

            const updated = await prisma.businessUser.update({
                where: {
                    account_id: req.auth.sub,
                },
                data: req.body,
            });

            const payload = { id: req.auth.sub };
            for (const key of keys) {
                payload[key] = updated[key];
            }
            return res.status(200).json(payload);
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/me/jobs')
        .post(requireAuth, requireRole(['business']), async (req, res) => {
            const err = validatePayload(req.body, ['position_type_id', 'salary_min', 'salary_max', 'start_time', 'end_time'], ['note']);
            if (err) {
                return sendError(res, 400, err);
            }

            const {
                position_type_id,
                salary_min,
                salary_max,
                start_time,
                end_time,
                note = '',
            } = req.body;

            if (
                !Number.isInteger(position_type_id) ||
                typeof salary_min !== 'number' ||
                typeof salary_max !== 'number' ||
                typeof note !== 'string'
            ) {
                return sendError(res, 400, 'invalid field type');
            }

            if (salary_min < 0 || salary_max < salary_min) {
                return sendError(res, 400, 'invalid salary range');
            }

            const start = parseIsoDateTime(start_time);
            const end = parseIsoDateTime(end_time);
            if (!start || !end) {
                return sendError(res, 400, 'invalid date format');
            }

            const nowMs = Date.now();
            const startMs = start.getTime();
            const endMs = end.getTime();
            if (startMs <= nowMs || endMs <= nowMs || endMs <= startMs) {
                return sendError(res, 400, 'invalid job time window');
            }

            const maxStartMs = nowMs + jobStartWindowHours * 60 * 60 * 1000;
            if (startMs > maxStartMs) {
                return sendError(res, 400, 'job starts too far in the future');
            }

            const business = await prisma.account.findUnique({
                where: { id: req.auth.sub },
                include: { businessProfile: true },
            });
            if (!business || !business.businessProfile) {
                return sendError(res, 404, 'Not Found');
            }
            if (!business.businessProfile.verified) {
                return sendError(res, 403, 'Forbidden');
            }

            const positionType = await prisma.positionType.findUnique({
                where: { id: position_type_id },
            });
            if (!positionType) {
                return sendError(res, 404, 'Not Found');
            }

            const latestNegotiationStartMs = startMs - negotiationWindowSeconds * 1000;
            const status = nowMs >= latestNegotiationStartMs ? 'expired' : 'open';

            const created = await prisma.job.create({
                data: {
                    business_id: req.auth.sub,
                    position_type_id,
                    status,
                    note,
                    salary_min,
                    salary_max,
                    start_time: start,
                    end_time: end,
                },
                include: {
                    positionType: true,
                    business: true,
                },
            });

            return res.status(201).json({
                id: created.id,
                status: created.status,
                position_type: {
                    id: created.positionType.id,
                    name: created.positionType.name,
                },
                business: {
                    id: created.business.account_id,
                    business_name: created.business.business_name,
                },
                worker: null,
                note: created.note,
                salary_min: created.salary_min,
                salary_max: created.salary_max,
                start_time: created.start_time,
                end_time: created.end_time,
                updatedAt: created.updatedAt,
            });
        })
        .get(requireAuth, requireRole(['business']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const where = {
                business_id: req.auth.sub,
            };

            if (req.query.position_type_id !== undefined) {
                const pt = parseInt(req.query.position_type_id, 10);
                if (isNaN(pt)) {
                    return sendError(res, 400, 'invalid position_type_id');
                }
                where.position_type_id = pt;
            }

            if (req.query.salary_min !== undefined) {
                const min = Number(req.query.salary_min);
                if (isNaN(min)) {
                    return sendError(res, 400, 'invalid salary_min');
                }
                where.salary_min = { gte: min };
            }

            if (req.query.salary_max !== undefined) {
                const max = Number(req.query.salary_max);
                if (isNaN(max)) {
                    return sendError(res, 400, 'invalid salary_max');
                }
                where.salary_max = { gte: max };
            }

            if (req.query.start_time !== undefined) {
                const start = parseIsoDateTime(req.query.start_time);
                if (!start) {
                    return sendError(res, 400, 'invalid start_time');
                }
                where.start_time = { gte: start };
            }

            if (req.query.end_time !== undefined) {
                const end = parseIsoDateTime(req.query.end_time);
                if (!end) {
                    return sendError(res, 400, 'invalid end_time');
                }
                where.end_time = { lte: end };
            }

            const requestedStatuses = (() => {
                if (req.query.status === undefined) {
                    return ['open', 'filled'];
                }
                if (Array.isArray(req.query.status)) {
                    return req.query.status;
                }
                if (typeof req.query.status === 'string') {
                    return req.query.status.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                }
                return null;
            })();

            if (!requestedStatuses || requestedStatuses.length === 0) {
                return sendError(res, 400, 'invalid status filter');
            }
            const validStatuses = new Set(['open', 'expired', 'filled', 'canceled', 'completed']);
            for (const s of requestedStatuses) {
                if (!validStatuses.has(s)) {
                    return sendError(res, 400, 'invalid status filter');
                }
            }

            const rows = await prisma.job.findMany({
                where,
                include: {
                    positionType: true,
                    worker: true,
                },
                orderBy: {
                    updatedAt: 'desc',
                },
            });

            const nowMs = Date.now();
            const filtered = rows
                .map((row) => ({ row, effectiveStatus: computeEffectiveJobStatus(row, nowMs) }))
                .filter((x) => requestedStatuses.includes(x.effectiveStatus));

            const count = filtered.length;
            const paged = filtered.slice((page - 1) * limit, page * limit);

            return res.status(200).json({
                count,
                results: paged.map(({ row, effectiveStatus }) => ({
                    id: row.id,
                    status: effectiveStatus,
                    position_type: {
                        id: row.positionType.id,
                        name: row.positionType.name,
                    },
                    business_id: row.business_id,
                    worker: row.worker
                        ? {
                            id: row.worker.account_id,
                            first_name: row.worker.first_name,
                            last_name: row.worker.last_name,
                        }
                        : null,
                    salary_min: row.salary_min,
                    salary_max: row.salary_max,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    updatedAt: row.updatedAt,
                })),
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/me/jobs/:jobId')
        .patch(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const err = validatePayload(req.body, [], ['salary_min', 'salary_max', 'start_time', 'end_time', 'note']);
            if (err) {
                return sendError(res, 400, err);
            }

            const keys = Object.keys(req.body);
            if (keys.length === 0) {
                return sendError(res, 400, 'no fields to update');
            }

            const job = await prisma.job.findFirst({
                where: {
                    id: jobId,
                    business_id: req.auth.sub,
                },
            });
            if (!job) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);
            if (!(effectiveStatus === 'open' || effectiveStatus === 'expired')) {
                return sendError(res, 409, 'job is not editable');
            }

            const hasActive = await hasActiveNegotiationForJob(job.id, nowMs);
            if (hasActive) {
                return sendError(res, 409, 'job has active negotiation');
            }

            const next = {
                salary_min: req.body.salary_min !== undefined ? req.body.salary_min : job.salary_min,
                salary_max: req.body.salary_max !== undefined ? req.body.salary_max : job.salary_max,
                start_time: req.body.start_time !== undefined ? parseIsoDateTime(req.body.start_time) : job.start_time,
                end_time: req.body.end_time !== undefined ? parseIsoDateTime(req.body.end_time) : job.end_time,
                note: req.body.note !== undefined ? req.body.note : job.note,
            };

            if (
                typeof next.salary_min !== 'number' ||
                typeof next.salary_max !== 'number' ||
                next.salary_min < 0 ||
                next.salary_max < next.salary_min ||
                typeof next.note !== 'string' ||
                !next.start_time ||
                !next.end_time
            ) {
                return sendError(res, 400, 'invalid job payload');
            }

            const startMs = next.start_time.getTime();
            const endMs = next.end_time.getTime();
            const maxStartMs = nowMs + jobStartWindowHours * 60 * 60 * 1000;
            if (startMs <= nowMs || endMs <= nowMs || endMs <= startMs || startMs > maxStartMs) {
                return sendError(res, 400, 'invalid job time window');
            }

            const latestNegotiationStartMs = startMs - negotiationWindowSeconds * 1000;
            const nextStatus = nowMs >= latestNegotiationStartMs ? 'expired' : 'open';

            const updated = await prisma.job.update({
                where: { id: jobId },
                data: {
                    salary_min: next.salary_min,
                    salary_max: next.salary_max,
                    start_time: next.start_time,
                    end_time: next.end_time,
                    note: next.note,
                    status: nextStatus,
                },
            });

            const payload = {
                id: updated.id,
                updatedAt: updated.updatedAt,
            };
            for (const key of keys) {
                payload[key] = updated[key];
            }
            return res.status(200).json(payload);
        })
        .delete(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const job = await prisma.job.findFirst({
                where: {
                    id: jobId,
                    business_id: req.auth.sub,
                },
            });
            if (!job) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);
            if (!(effectiveStatus === 'open' || effectiveStatus === 'expired')) {
                return sendError(res, 409, 'job is not deletable');
            }

            const hasActive = await hasActiveNegotiationForJob(job.id, nowMs);
            if (hasActive) {
                return sendError(res, 409, 'job has active negotiation');
            }

            await prisma.job.delete({
                where: { id: jobId },
            });
            return res.status(204).send();
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs')
        .get(requireAuth, requireRole(['regular']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const hasLat = req.query.lat !== undefined;
            const hasLon = req.query.lon !== undefined;
            if (hasLat !== hasLon) {
                return sendError(res, 400, 'lat and lon must be provided together');
            }

            let lat = null;
            let lon = null;
            if (hasLat && hasLon) {
                lat = Number(req.query.lat);
                lon = Number(req.query.lon);
                if (isNaN(lat) || isNaN(lon)) {
                    return sendError(res, 400, 'invalid coordinates');
                }
            }

            const sort = req.query.sort || 'start_time';
            const order = req.query.order === 'desc' ? 'desc' : 'asc';
            if (!['updatedAt', 'start_time', 'salary_min', 'salary_max', 'distance', 'eta'].includes(sort)) {
                return sendError(res, 400, 'invalid sort');
            }
            if (req.query.order !== undefined && req.query.order !== 'asc' && req.query.order !== 'desc') {
                return sendError(res, 400, 'invalid order');
            }
            if ((sort === 'distance' || sort === 'eta') && (!hasLat || !hasLon)) {
                return sendError(res, 400, 'distance/eta sorting requires lat and lon');
            }

            const where = {
                status: {
                    in: ['open', 'expired'],
                },
            };

            if (req.query.position_type_id !== undefined) {
                const pt = parseInt(req.query.position_type_id, 10);
                if (isNaN(pt)) {
                    return sendError(res, 400, 'invalid position_type_id');
                }
                where.position_type_id = pt;
            }

            if (req.query.business_id !== undefined) {
                const bid = parseInt(req.query.business_id, 10);
                if (isNaN(bid)) {
                    return sendError(res, 400, 'invalid business_id');
                }
                where.business_id = bid;
            }

            const rows = await prisma.job.findMany({
                where,
                include: {
                    business: true,
                    positionType: true,
                },
            });

            const nowMs = Date.now();
            const results = [];
            for (const row of rows) {
                const effectiveStatus = computeEffectiveJobStatus(row, nowMs);
                if (effectiveStatus !== 'open') {
                    continue;
                }

                const qualified = await isQualifiedForPosition(req.auth.sub, row.position_type_id);
                if (!qualified) {
                    continue;
                }

                const item = {
                    id: row.id,
                    status: effectiveStatus,
                    position_type: {
                        id: row.positionType.id,
                        name: row.positionType.name,
                    },
                    business: {
                        id: row.business.account_id,
                        business_name: row.business.business_name,
                    },
                    salary_min: row.salary_min,
                    salary_max: row.salary_max,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    updatedAt: row.updatedAt,
                };

                if (hasLat && hasLon) {
                    const bLoc = row.business.location;
                    if (bLoc && typeof bLoc.lat === 'number' && typeof bLoc.lon === 'number') {
                        const distance = haversineDistanceKm(lat, lon, bLoc.lat, bLoc.lon);
                        const eta = (distance / 30) * 60;
                        item.distance = Number(distance.toFixed(3));
                        item.eta = Number(eta.toFixed(3));
                    }
                }

                results.push(item);
            }

            const compare = (a, b, field) => {
                if (a[field] < b[field]) {
                    return order === 'asc' ? -1 : 1;
                }
                if (a[field] > b[field]) {
                    return order === 'asc' ? 1 : -1;
                }
                return 0;
            };

            results.sort((a, b) => {
                if (sort === 'distance' || sort === 'eta' || sort === 'salary_min' || sort === 'salary_max') {
                    return compare(a, b, sort);
                }
                if (sort === 'start_time') {
                    return compare(a, b, 'start_time');
                }
                return compare(a, b, 'updatedAt');
            });

            const count = results.length;
            const paged = results.slice((page - 1) * limit, page * limit);
            return res.status(200).json({ count, results: paged });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId')
        .get(requireAuth, requireRole(['regular', 'business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const hasLat = req.query.lat !== undefined;
            const hasLon = req.query.lon !== undefined;
            if (hasLat !== hasLon) {
                return sendError(res, 400, 'lat and lon must be provided together');
            }

            if (req.auth.role === 'business' && (hasLat || hasLon)) {
                return sendError(res, 400, 'business cannot specify lat/lon');
            }

            let lat = null;
            let lon = null;
            if (hasLat && hasLon) {
                lat = Number(req.query.lat);
                lon = Number(req.query.lon);
                if (isNaN(lat) || isNaN(lon)) {
                    return sendError(res, 400, 'invalid coordinates');
                }
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
                include: {
                    business: true,
                    worker: true,
                    positionType: true,
                },
            });
            if (!job) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);

            if (req.auth.role === 'business') {
                if (job.business_id !== req.auth.sub) {
                    return sendError(res, 404, 'Not Found');
                }
            }

            if (req.auth.role === 'regular') {
                const ownedOutcome = ['filled', 'canceled', 'completed'].includes(effectiveStatus) && job.worker_id === req.auth.sub;
                if (!(effectiveStatus === 'open' || ownedOutcome)) {
                    return sendError(res, 404, 'Not Found');
                }

                const qualified = await isQualifiedForPosition(req.auth.sub, job.position_type_id);
                if (!qualified) {
                    return sendError(res, 403, 'Forbidden');
                }
            }

            const payload = {
                id: job.id,
                status: effectiveStatus,
                position_type: {
                    id: job.positionType.id,
                    name: job.positionType.name,
                },
                business: {
                    id: job.business.account_id,
                    business_name: job.business.business_name,
                },
                worker: job.worker
                    ? {
                        id: job.worker.account_id,
                        first_name: job.worker.first_name,
                        last_name: job.worker.last_name,
                    }
                    : null,
                note: job.note,
                salary_min: job.salary_min,
                salary_max: job.salary_max,
                start_time: job.start_time,
                end_time: job.end_time,
                updatedAt: job.updatedAt,
            };

            if (hasLat && hasLon && req.auth.role === 'regular') {
                const bLoc = job.business.location;
                if (bLoc && typeof bLoc.lat === 'number' && typeof bLoc.lon === 'number') {
                    const distance = haversineDistanceKm(lat, lon, bLoc.lat, bLoc.lon);
                    const eta = (distance / 30) * 60;
                    payload.distance = Number(distance.toFixed(3));
                    payload.eta = Number(eta.toFixed(3));
                }
            }

            return res.status(200).json(payload);
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/no-show')
        .patch(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
            });
            if (!job) {
                return sendError(res, 404, 'Not Found');
            }
            if (job.business_id !== req.auth.sub) {
                return sendError(res, 403, 'Forbidden');
            }

            const nowMs = Date.now();
            const startMs = new Date(job.start_time).getTime();
            const endMs = new Date(job.end_time).getTime();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);
            if (effectiveStatus !== 'filled' || nowMs < startMs || nowMs >= endMs) {
                return sendError(res, 409, 'no-show not allowed at this time');
            }

            const updated = await prisma.$transaction(async (tx) => {
                const jobUpdated = await tx.job.update({
                    where: { id: jobId },
                    data: {
                        status: 'canceled',
                    },
                });

                if (job.worker_id) {
                    await tx.regularUser.update({
                        where: { account_id: job.worker_id },
                        data: { suspended: true },
                    });
                }

                return jobUpdated;
            });

            return res.status(200).json({
                id: updated.id,
                status: updated.status,
                updatedAt: updated.updatedAt,
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/candidates')
        .get(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
            });
            if (!job || job.business_id !== req.auth.sub) {
                return sendError(res, 404, 'Not Found');
            }

            const interests = await prisma.interest.findMany({
                where: {
                    job_id: jobId,
                },
                select: {
                    candidate_id: true,
                    business_interested: true,
                },
            });
            const invitedMap = new Map();
            for (const interest of interests) {
                invitedMap.set(interest.candidate_id, interest.business_interested === true);
            }

            const accounts = await prisma.account.findMany({
                where: {
                    role: 'regular',
                },
                include: {
                    regularProfile: true,
                },
                orderBy: {
                    id: 'asc',
                },
            });

            const nowMs = Date.now();
            const discoverableRows = [];
            for (const account of accounts) {
                if (!account.regularProfile) {
                    continue;
                }

                const discoverable = await isDiscoverableForJob(account.id, job, nowMs);
                if (!discoverable) {
                    continue;
                }

                discoverableRows.push({
                    id: account.id,
                    first_name: account.regularProfile.first_name,
                    last_name: account.regularProfile.last_name,
                    invited: invitedMap.get(account.id) === true,
                });
            }

            const count = discoverableRows.length;
            const results = discoverableRows.slice((page - 1) * limit, page * limit);
            return res.status(200).json({ count, results });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/candidates/:userId')
        .get(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            const userId = parseInt(req.params.userId, 10);
            if (isNaN(jobId) || isNaN(userId)) {
                return sendError(res, 400, 'invalid route params');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
                include: {
                    positionType: true,
                },
            });
            if (!job || job.business_id !== req.auth.sub) {
                return sendError(res, 404, 'Not Found');
            }

            const account = await prisma.account.findUnique({
                where: { id: userId },
                include: {
                    regularProfile: true,
                },
            });
            if (!account || account.role !== 'regular' || !account.regularProfile) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const filledException =
                job.worker_id === userId &&
                nowMs < new Date(job.end_time).getTime();

            if (!filledException) {
                const discoverable = await isDiscoverableForJob(userId, job, nowMs);
                if (!discoverable) {
                    return sendError(res, 403, 'Forbidden');
                }
            }

            const qualification = await prisma.qualification.findFirst({
                where: {
                    user_id: userId,
                    position_type_id: job.position_type_id,
                    status: 'approved',
                },
                orderBy: {
                    updatedAt: 'desc',
                },
            });
            if (!qualification) {
                return sendError(res, 403, 'Forbidden');
            }

            const userPayload = {
                id: account.id,
                first_name: account.regularProfile.first_name,
                last_name: account.regularProfile.last_name,
                avatar: account.regularProfile.avatar,
                resume: account.regularProfile.resume,
                biography: account.regularProfile.biography,
                qualification: {
                    id: qualification.id,
                    position_type_id: qualification.position_type_id,
                    document: qualification.document,
                    note: qualification.note,
                    updatedAt: qualification.updatedAt,
                },
            };

            if (job.worker_id === userId) {
                userPayload.email = account.email;
                userPayload.phone_number = account.regularProfile.phone_number;
            }

            return res.status(200).json({
                user: userPayload,
                job: {
                    id: job.id,
                    status: computeEffectiveJobStatus(job, nowMs),
                    position_type: {
                        id: job.positionType.id,
                        name: job.positionType.name,
                        description: job.positionType.description,
                    },
                    start_time: job.start_time,
                    end_time: job.end_time,
                },
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/interested')
        .patch(requireAuth, requireRole(['regular']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const err = validatePayload(req.body, ['interested'], []);
            if (err) {
                return sendError(res, 400, err);
            }
            if (typeof req.body.interested !== 'boolean') {
                return sendError(res, 400, 'invalid interested');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
            });
            if (!job) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);
            if (effectiveStatus !== 'open') {
                return sendError(res, 409, 'job is not available');
            }

            const qualified = await isQualifiedForPosition(req.auth.sub, job.position_type_id);
            if (!qualified) {
                return sendError(res, 403, 'Forbidden');
            }

            const existing = await prisma.interest.findUnique({
                where: {
                    job_id_candidate_id: {
                        job_id: jobId,
                        candidate_id: req.auth.sub,
                    },
                },
            });

            if (!req.body.interested) {
                if (!existing || existing.candidate_interested !== true) {
                    return sendError(res, 400, 'nothing to withdraw');
                }

                const updated = await prisma.interest.update({
                    where: { id: existing.id },
                    data: {
                        candidate_interested: false,
                    },
                });

                return res.status(200).json({
                    id: updated.id,
                    job_id: updated.job_id,
                    candidate: {
                        id: updated.candidate_id,
                        interested: updated.candidate_interested,
                    },
                    business: {
                        id: job.business_id,
                        interested: updated.business_interested,
                    },
                });
            }

            const activeNegotiation = await prisma.negotiation.findFirst({
                where: {
                    job_id: jobId,
                    candidate_id: req.auth.sub,
                    status: 'active',
                    expiresAt: {
                        gt: new Date(nowMs),
                    },
                },
            });
            if (activeNegotiation) {
                return sendError(res, 409, 'active negotiation in progress');
            }

            const updated = existing
                ? await prisma.interest.update({
                    where: { id: existing.id },
                    data: {
                        candidate_interested: true,
                    },
                })
                : await prisma.interest.create({
                    data: {
                        job_id: jobId,
                        candidate_id: req.auth.sub,
                        candidate_interested: true,
                        business_interested: null,
                    },
                });

            await prisma.regularUser.update({
                where: { account_id: req.auth.sub },
                data: {
                    last_active_at: new Date(nowMs),
                    available: true,
                },
            });

            return res.status(200).json({
                id: updated.id,
                job_id: updated.job_id,
                candidate: {
                    id: updated.candidate_id,
                    interested: updated.candidate_interested,
                },
                business: {
                    id: job.business_id,
                    interested: updated.business_interested,
                },
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/users/me/invitations')
        .get(requireAuth, requireRole(['regular']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const interests = await prisma.interest.findMany({
                where: {
                    candidate_id: req.auth.sub,
                    business_interested: true,
                    OR: [
                        { candidate_interested: null },
                        { candidate_interested: false },
                    ],
                },
                include: {
                    job: {
                        include: {
                            positionType: true,
                            business: true,
                        },
                    },
                },
                orderBy: {
                    updatedAt: 'desc',
                },
            });

            const nowMs = Date.now();
            const mapped = interests
                .map((interest) => {
                    const job = interest.job;
                    const status = computeEffectiveJobStatus(job, nowMs);
                    if (status !== 'open') {
                        return null;
                    }

                    return {
                        id: job.id,
                        status,
                        position_type: {
                            id: job.positionType.id,
                            name: job.positionType.name,
                        },
                        business: {
                            id: job.business.account_id,
                            business_name: job.business.business_name,
                        },
                        salary_min: job.salary_min,
                        salary_max: job.salary_max,
                        start_time: job.start_time,
                        end_time: job.end_time,
                        updatedAt: job.updatedAt,
                    };
                })
                .filter((x) => x !== null);

            const count = mapped.length;
            const results = mapped.slice((page - 1) * limit, page * limit);
            return res.status(200).json({ count, results });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/users/me/interests')
        .get(requireAuth, requireRole(['regular']), async (req, res) => {
            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const interests = await prisma.interest.findMany({
                where: {
                    candidate_id: req.auth.sub,
                    candidate_interested: true,
                },
                include: {
                    job: {
                        include: {
                            business: true,
                            positionType: true,
                        },
                    },
                },
                orderBy: {
                    updatedAt: 'desc',
                },
            });

            const nowMs = Date.now();
            const mapped = interests
                .map((interest) => {
                    const job = interest.job;
                    const status = computeEffectiveJobStatus(job, nowMs);
                    if (status !== 'open') {
                        return null;
                    }

                    return {
                        interest_id: interest.id,
                        mutual: interest.business_interested === true && interest.candidate_interested === true,
                        job: {
                            id: job.id,
                            status,
                            position_type: {
                                id: job.positionType.id,
                                name: job.positionType.name,
                            },
                            business: {
                                id: job.business.account_id,
                                business_name: job.business.business_name,
                            },
                            salary_min: job.salary_min,
                            salary_max: job.salary_max,
                            start_time: job.start_time,
                            end_time: job.end_time,
                            updatedAt: job.updatedAt,
                        },
                    };
                })
                .filter((x) => x !== null);

            const count = mapped.length;
            const results = mapped.slice((page - 1) * limit, page * limit);
            return res.status(200).json({ count, results });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/interests')
        .get(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            if (isNaN(jobId)) {
                return sendError(res, 400, 'invalid jobId');
            }

            const page = parsePositiveInt(req.query.page, 1);
            const limit = parsePositiveInt(req.query.limit, 10);
            if (page === null || limit === null) {
                return sendError(res, 400, 'invalid pagination');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
            });
            if (!job || job.business_id !== req.auth.sub) {
                return sendError(res, 404, 'Not Found');
            }

            const interests = await prisma.interest.findMany({
                where: {
                    job_id: jobId,
                    candidate_interested: true,
                },
                include: {
                    candidate: true,
                },
                orderBy: {
                    updatedAt: 'desc',
                },
            });

            const count = interests.length;
            const rows = interests.slice((page - 1) * limit, page * limit);
            return res.status(200).json({
                count,
                results: rows.map((interest) => ({
                    interest_id: interest.id,
                    mutual: interest.business_interested === true && interest.candidate_interested === true,
                    user: {
                        id: interest.candidate.account_id,
                        first_name: interest.candidate.first_name,
                        last_name: interest.candidate.last_name,
                    },
                })),
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/jobs/:jobId/candidates/:userId/interested')
        .patch(requireAuth, requireRole(['business']), async (req, res) => {
            const jobId = parseInt(req.params.jobId, 10);
            const userId = parseInt(req.params.userId, 10);
            if (isNaN(jobId) || isNaN(userId)) {
                return sendError(res, 400, 'invalid route params');
            }

            const err = validatePayload(req.body, ['interested'], []);
            if (err) {
                return sendError(res, 400, err);
            }
            if (typeof req.body.interested !== 'boolean') {
                return sendError(res, 400, 'invalid interested');
            }

            const job = await prisma.job.findUnique({
                where: { id: jobId },
            });
            if (!job || job.business_id !== req.auth.sub) {
                return sendError(res, 404, 'Not Found');
            }

            const candidate = await prisma.account.findUnique({
                where: { id: userId },
                include: { regularProfile: true },
            });
            if (!candidate || candidate.role !== 'regular' || !candidate.regularProfile) {
                return sendError(res, 404, 'Not Found');
            }

            const nowMs = Date.now();
            const effectiveStatus = computeEffectiveJobStatus(job, nowMs);
            if (effectiveStatus !== 'open') {
                return sendError(res, 409, 'job is not open');
            }

            const discoverable = await isDiscoverableForJob(userId, job, nowMs);
            if (!discoverable) {
                return sendError(res, 403, 'Forbidden');
            }

            const existing = await prisma.interest.findUnique({
                where: {
                    job_id_candidate_id: {
                        job_id: jobId,
                        candidate_id: userId,
                    },
                },
            });

            if (!req.body.interested) {
                if (!existing || existing.business_interested !== true) {
                    return sendError(res, 400, 'nothing to withdraw');
                }

                const updated = await prisma.interest.update({
                    where: { id: existing.id },
                    data: {
                        business_interested: false,
                    },
                });

                return res.status(200).json({
                    id: updated.id,
                    job_id: updated.job_id,
                    candidate: {
                        id: updated.candidate_id,
                        interested: updated.candidate_interested,
                    },
                    business: {
                        id: job.business_id,
                        interested: updated.business_interested,
                    },
                });
            }

            const updated = existing
                ? await prisma.interest.update({
                    where: { id: existing.id },
                    data: {
                        business_interested: true,
                    },
                })
                : await prisma.interest.create({
                    data: {
                        job_id: jobId,
                        candidate_id: userId,
                        candidate_interested: null,
                        business_interested: true,
                    },
                });

            return res.status(200).json({
                id: updated.id,
                job_id: updated.job_id,
                candidate: {
                    id: updated.candidate_id,
                    interested: updated.candidate_interested,
                },
                business: {
                    id: job.business_id,
                    interested: updated.business_interested,
                },
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/negotiations')
        .post(requireAuth, requireRole(['regular', 'business']), async (req, res) => {
            const err = validatePayload(req.body, ['interest_id'], []);
            if (err) {
                return sendError(res, 400, err);
            }
            if (!Number.isInteger(req.body.interest_id)) {
                return sendError(res, 400, 'invalid interest_id');
            }

            const nowMs = Date.now();
            await finalizeExpiredNegotiationsForAccount(req.auth.sub, req.auth.role, nowMs);
            const interestId = req.body.interest_id;
            const interest = await prisma.interest.findUnique({
                where: { id: interestId },
                include: {
                    job: true,
                },
            });
            if (!interest) {
                return sendError(res, 404, 'Not Found');
            }

            const isParty =
                req.auth.sub === interest.candidate_id ||
                req.auth.sub === interest.job.business_id;
            if (!isParty) {
                return sendError(res, 404, 'Not Found');
            }

            if (!(interest.candidate_interested === true && interest.business_interested === true)) {
                return sendError(res, 403, 'mutual interest required');
            }

            const existingSame = await prisma.negotiation.findFirst({
                where: {
                    interest_id: interestId,
                    status: 'active',
                    expiresAt: {
                        gt: new Date(nowMs),
                    },
                },
                include: {
                    job: {
                        include: {
                            positionType: true,
                            business: true,
                        },
                    },
                    candidate: true,
                    messages: {
                        orderBy: {
                            createdAt: 'asc',
                        },
                    },
                },
            });
            if (existingSame) {
                return res.status(200).json(serializeNegotiation(existingSame));
            }

            const job = await prisma.job.findUnique({
                where: { id: interest.job_id },
            });
            if (!job || computeEffectiveJobStatus(job, nowMs) !== 'open') {
                return sendError(res, 409, 'job not available for negotiation');
            }

            const discoverable = await isDiscoverableForJob(interest.candidate_id, job, nowMs);
            if (!discoverable) {
                return sendError(res, 403, 'candidate not discoverable');
            }

            const activeForCandidate = await prisma.negotiation.findFirst({
                where: {
                    candidate_id: interest.candidate_id,
                    status: 'active',
                    expiresAt: {
                        gt: new Date(nowMs),
                    },
                },
            });
            if (activeForCandidate) {
                return sendError(res, 409, 'candidate already in active negotiation');
            }

            const activeForBusiness = await prisma.negotiation.findFirst({
                where: {
                    business_id: interest.job.business_id,
                    status: 'active',
                    expiresAt: {
                        gt: new Date(nowMs),
                    },
                },
            });
            if (activeForBusiness) {
                return sendError(res, 409, 'business already in active negotiation');
            }

            const expiresAt = new Date(nowMs + negotiationWindowSeconds * 1000);
            const created = await prisma.negotiation.create({
                data: {
                    interest_id: interestId,
                    job_id: interest.job_id,
                    candidate_id: interest.candidate_id,
                    business_id: interest.job.business_id,
                    status: 'active',
                    expiresAt,
                },
                include: {
                    job: {
                        include: {
                            positionType: true,
                            business: true,
                        },
                    },
                    candidate: true,
                    messages: {
                        orderBy: {
                            createdAt: 'asc',
                        },
                    },
                },
            });

            notifyNegotiationStarted(created);

            return res.status(201).json(serializeNegotiation(created));
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/negotiations/me')
        .get(requireAuth, requireRole(['regular', 'business']), async (req, res) => {
            const nowMs = Date.now();
            await finalizeExpiredNegotiationsForAccount(req.auth.sub, req.auth.role, nowMs);
            const negotiation = await getActiveNegotiationForAccount(req.auth.sub, req.auth.role, nowMs);
            if (!negotiation) {
                return sendError(res, 404, 'Not Found');
            }

            return res.status(200).json(serializeNegotiation(negotiation));
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/negotiations/me/decision')
        .patch(requireAuth, requireRole(['regular', 'business']), async (req, res) => {
            const err = validatePayload(req.body, ['decision', 'negotiation_id'], []);
            if (err) {
                return sendError(res, 400, err);
            }

            if ((req.body.decision !== 'accept' && req.body.decision !== 'decline') || !Number.isInteger(req.body.negotiation_id)) {
                return sendError(res, 400, 'invalid decision payload');
            }

            const nowMs = Date.now();
            await finalizeExpiredNegotiationsForAccount(req.auth.sub, req.auth.role, nowMs);
            const negotiation = await prisma.negotiation.findUnique({
                where: { id: req.body.negotiation_id },
            });
            if (!negotiation) {
                return sendError(res, 404, 'Not Found');
            }

            if (
                (req.auth.role === 'regular' && negotiation.candidate_id !== req.auth.sub) ||
                (req.auth.role === 'business' && negotiation.business_id !== req.auth.sub)
            ) {
                return sendError(res, 404, 'Not Found');
            }

            const negotiationExpired = new Date(negotiation.expiresAt).getTime() <= nowMs;
            if (negotiation.status !== 'active' || negotiationExpired) {
                return sendError(res, 409, 'negotiation is not active');
            }

            const updated = await prisma.$transaction(async (tx) => {
                const patch = {};
                if (req.auth.role === 'regular') {
                    patch.candidate_decision = req.body.decision;
                } else {
                    patch.business_decision = req.body.decision;
                }

                let negotiation = await tx.negotiation.update({
                    where: { id: req.body.negotiation_id },
                    data: patch,
                });

                if (negotiation.candidate_decision === 'decline' || negotiation.business_decision === 'decline') {
                    negotiation = await tx.negotiation.update({
                        where: { id: negotiation.id },
                        data: { status: 'failed' },
                    });

                    await tx.interest.update({
                        where: { id: negotiation.interest_id },
                        data: {
                            candidate_interested: null,
                            business_interested: null,
                        },
                    });

                    await tx.regularUser.update({
                        where: { account_id: negotiation.candidate_id },
                        data: {
                            available: true,
                            last_active_at: new Date(nowMs),
                        },
                    });
                } else if (
                    negotiation.candidate_decision === 'accept' &&
                    negotiation.business_decision === 'accept'
                ) {
                    negotiation = await tx.negotiation.update({
                        where: { id: negotiation.id },
                        data: { status: 'success' },
                    });

                    await tx.job.update({
                        where: { id: negotiation.job_id },
                        data: {
                            status: 'filled',
                            worker_id: negotiation.candidate_id,
                        },
                    });

                    await tx.regularUser.update({
                        where: { account_id: negotiation.candidate_id },
                        data: {
                            available: true,
                            last_active_at: new Date(nowMs),
                        },
                    });
                }

                return tx.negotiation.findUnique({
                    where: { id: negotiation.id },
                    include: {
                        job: {
                            include: {
                                positionType: true,
                                business: true,
                            },
                        },
                        candidate: true,
                    },
                });
            });

            if (!updated) {
                return sendError(res, 500, 'failed to load updated negotiation');
            }

            return res.status(200).json({
                id: updated.id,
                status: updated.status,
                createdAt: updated.createdAt,
                expiresAt: updated.expiresAt,
                updatedAt: updated.updatedAt,
                decisions: {
                    candidate: updated.candidate_decision,
                    business: updated.business_decision,
                },
            });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/users/me/avatar')
        .put(requireAuth, requireRole(['regular']), upload.single('file'), async (req, res) => {
            if (!req.file) {
                return sendError(res, 400, 'missing file');
            }
            if (!(req.file.mimetype === 'image/png' || req.file.mimetype === 'image/jpeg')) {
                return sendError(res, 400, 'invalid image type');
            }

            const ext = extForMime(req.file.mimetype);
            const relative = `/uploads/users/${req.auth.sub}/avatar${ext}`;
            saveUpload(relative, req.file.buffer);

            await prisma.regularUser.update({
                where: { account_id: req.auth.sub },
                data: { avatar: relative },
            });

            return res.status(200).json({ avatar: relative });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/businesses/me/avatar')
        .put(requireAuth, requireRole(['business']), upload.single('file'), async (req, res) => {
            if (!req.file) {
                return sendError(res, 400, 'missing file');
            }
            if (!(req.file.mimetype === 'image/png' || req.file.mimetype === 'image/jpeg')) {
                return sendError(res, 400, 'invalid image type');
            }

            const ext = extForMime(req.file.mimetype);
            const relative = `/uploads/businesses/${req.auth.sub}/avatar${ext}`;
            saveUpload(relative, req.file.buffer);

            await prisma.businessUser.update({
                where: { account_id: req.auth.sub },
                data: { avatar: relative },
            });

            return res.status(200).json({ avatar: relative });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/users/me/resume')
        .put(requireAuth, requireRole(['regular']), upload.single('file'), async (req, res) => {
            if (!req.file) {
                return sendError(res, 400, 'missing file');
            }
            if (req.file.mimetype !== 'application/pdf') {
                return sendError(res, 400, 'invalid document type');
            }

            const relative = `/uploads/users/${req.auth.sub}/resume.pdf`;
            saveUpload(relative, req.file.buffer);

            await prisma.regularUser.update({
                where: { account_id: req.auth.sub },
                data: { resume: relative },
            });

            return res.status(200).json({ resume: relative });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.route('/qualifications/:qualificationId/document')
        .put(requireAuth, requireRole(['regular']), upload.single('file'), async (req, res) => {
            const qualificationId = parseInt(req.params.qualificationId, 10);
            if (isNaN(qualificationId)) {
                return sendError(res, 400, 'invalid qualificationId');
            }

            if (!req.file) {
                return sendError(res, 400, 'missing file');
            }
            if (req.file.mimetype !== 'application/pdf') {
                return sendError(res, 400, 'invalid document type');
            }

            const qualification = await prisma.qualification.findUnique({
                where: { id: qualificationId },
            });
            if (!qualification) {
                return sendError(res, 404, 'Not Found');
            }
            if (qualification.user_id !== req.auth.sub) {
                return sendError(res, 403, 'Forbidden');
            }

            const relative = `/uploads/users/${req.auth.sub}/position_type/${qualification.position_type_id}/document.pdf`;
            saveUpload(relative, req.file.buffer);

            await prisma.qualification.update({
                where: { id: qualificationId },
                data: { document: relative },
            });

            return res.status(200).json({ document: relative });
        })
        .all((_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.all('/system/reset-cooldown', (_req, res) => sendError(res, 405, 'Method Not Allowed'));
    app.all('/system/negotiation-window', (_req, res) => sendError(res, 405, 'Method Not Allowed'));
    app.all('/system/job-start-window', (_req, res) => sendError(res, 405, 'Method Not Allowed'));
    app.all('/system/availability-timeout', (_req, res) => sendError(res, 405, 'Method Not Allowed'));

    app.use((err, _req, res, _next) => {
        if (err && err.type === 'entity.parse.failed') {
            return sendError(res, 400, 'invalid JSON');
        }
        if (err instanceof multer.MulterError) {
            return sendError(res, 400, 'invalid multipart form data');
        }
        console.error(err);
        return sendError(res, 500, 'Internal Server Error');
    });

    app.use((_req, res) => {
        return sendError(res, 404, 'Not Found');
    });

    return app;
}

module.exports = { create_app };