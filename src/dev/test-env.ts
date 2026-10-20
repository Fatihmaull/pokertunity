/**
 * Environment a test needs before the modules under test are loaded.
 *
 * Some server modules need a connection string to load, which is the right
 * behaviour for a server and a hurdle for a test that runs zero queries.
 * Importing this first supplies a placeholder and keeps the check itself
 * strict. Import order is the mechanism: a module's dependencies are
 * evaluated before it is, so this runs before anything that reads the value.
 */
process.env.DATABASE_URL ||= 'postgres://placeholder/placeholder';
