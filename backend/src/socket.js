'use strict';

const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
let ioRef = null;

function emitNegotiationError(socket, error, message) {
  socket.emit('negotiation:error', { error, message });
}

function getSenderRole(userRole) {
  return userRole === 'business' ? 'business' : 'regular';
}

async function getActiveNegotiationForSocketUser(userId, userRole) {
  const where = {
    status: 'active',
    expiresAt: {
      gt: new Date(),
    },
  };
  if (userRole === 'business') {
    where.business_id = userId;
  } else {
    where.candidate_id = userId;
  }
  return prisma.negotiation.findFirst({ where, orderBy: { createdAt: 'desc' } });
}

function attach_sockets(server) {
  const io = new Server(server, { cors: { origin: '*' } });
  ioRef = io;

  io.use((socket, next) => {
    const token = socket.handshake?.auth?.token;
    if (!token) {
      return next(new Error('Not authenticated'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded || !decoded.sub || !decoded.role) {
        return next(new Error('Not authenticated'));
      }

      socket.data.userId = decoded.sub;
      socket.data.role = decoded.role;
      next();
    } catch {
      next(new Error('Not authenticated'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const role = socket.data.role;

    if (!userId || !role) {
      socket.disconnect(true);
      return;
    }

    socket.join(`account:${userId}`);

    getActiveNegotiationForSocketUser(userId, role)
      .then((active) => {
        if (!active) {
          return;
        }
        socket.join(`negotiation:${active.id}`);
        socket.emit('negotiation:started', { negotiation_id: active.id });
      })
      .catch(() => {
        // Keep the socket session alive even if active negotiation lookup fails.
      });

    socket.on('negotiation:message', async (payload) => {
      if (!socket.data.userId || !socket.data.role) {
        emitNegotiationError(socket, 'Not authenticated', 'Socket is not authenticated.');
        return;
      }

      if (!payload || typeof payload !== 'object') {
        emitNegotiationError(socket, 'Negotiation not found (or not active)', 'Invalid payload.');
        return;
      }

      const negotiationId = payload.negotiation_id;
      const text = payload.text;
      if (!Number.isInteger(negotiationId) || typeof text !== 'string') {
        emitNegotiationError(socket, 'Negotiation not found (or not active)', 'Invalid payload fields.');
        return;
      }

      const negotiation = await prisma.negotiation.findUnique({
        where: { id: negotiationId },
      });
      if (!negotiation || negotiation.status !== 'active' || new Date(negotiation.expiresAt).getTime() <= Date.now()) {
        emitNegotiationError(socket, 'Negotiation not found (or not active)', 'Negotiation is missing or inactive.');
        return;
      }

      const isParty =
        negotiation.candidate_id === socket.data.userId ||
        negotiation.business_id === socket.data.userId;
      if (!isParty) {
        emitNegotiationError(socket, 'Not part of this negotiation', 'User is not part of this negotiation.');
        return;
      }

      const current = await getActiveNegotiationForSocketUser(socket.data.userId, socket.data.role);
      if (!current || current.id !== negotiationId) {
        emitNegotiationError(socket, 'Negotiation mismatch', 'Payload negotiation does not match active negotiation.');
        return;
      }

      const senderRole = getSenderRole(socket.data.role);
      const messageRow = await prisma.negotiationMessage.create({
        data: {
          negotiation_id: negotiationId,
          sender_role: senderRole,
          sender_id: socket.data.userId,
          text,
        },
      });

      io.to(`negotiation:${negotiationId}`).emit('negotiation:message', {
        negotiation_id: negotiationId,
        sender: {
          role: senderRole,
          id: socket.data.userId,
        },
        text: messageRow.text,
        createdAt: messageRow.createdAt,
      });
    });
  });

  return io;
}

function notifyNegotiationStarted(negotiation) {
  if (!ioRef || !negotiation) {
    return;
  }

  const negotiationId = negotiation.id;
  const candidateAccountRoom = `account:${negotiation.candidate_id}`;
  const businessAccountRoom = `account:${negotiation.business_id}`;
  const negotiationRoom = `negotiation:${negotiationId}`;

  ioRef.in(candidateAccountRoom).socketsJoin(negotiationRoom);
  ioRef.in(businessAccountRoom).socketsJoin(negotiationRoom);

  ioRef.to(candidateAccountRoom).emit('negotiation:started', { negotiation_id: negotiationId });
  ioRef.to(businessAccountRoom).emit('negotiation:started', { negotiation_id: negotiationId });
}

module.exports = { attach_sockets, notifyNegotiationStarted };