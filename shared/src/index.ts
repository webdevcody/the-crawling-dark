// Public surface of the @crawling-dark/shared package.
// Both the client and the server import from here, guaranteeing a single
// source of truth for tunable game values, wire types, world geometry, and
// the movement simulation.
export * from './constants';
export * from './types';
export * from './protocol';
export * from './wire';
export * from './world';
export * from './sim';
