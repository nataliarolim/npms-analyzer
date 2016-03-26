'use strict';

const assert = require('assert');
const config = require('config');
const nano = require('nano');
const elasticsearch = require('elasticsearch');
const log = require('npmlog');
const analyze = require('../lib/analyze');
const queue = require('../lib/queue');
const score = require('../lib/scoring/score');
const stats = require('./stats');

const logPrefix = '';

// TODO: cleanup temporary folder

/**
 * Handles a message.
 *
 * @param {object}  msg      The message
 * @param {Nano}    npmNano  The npm nano instance
 * @param {Nano}    npmsNano The npms nano instance
 * @param {Elastic} esClient The elasticsearch instance
 *
 * @return {Promise} A promise that fulfills when consumed
 */
function onMessage(msg, npmNano, npmsNano, esClient) {
    const name = msg.data;

    // Check if this module is blacklisted
    const blacklisted = config.get('blacklist')[name];

    if (blacklisted) {
        log.info(logPrefix, `Module ${name} is blacklisted`, { reason: blacklisted });
        return Promise.resolve();
    }

    log.info(logPrefix, `Processing module ${name}`);

    // Check if the module has been analyzed after it has been pushed to the queue
    return analyze.get(name, npmsNano)
    .catch({ code: 'ANALYSIS_NOT_FOUND' }, () => {})
    .then((analysis) => {
        if (analysis && Date.parse(analysis.startedAt) >= Date.parse(msg.pushedAt)) {
            log.info(logPrefix, `Skipping analysis of ${name} because it was already analyzed meanwhile`);
            return;
        }

        // If not, analyze it! :D
        return analyze(name, npmNano, npmsNano, {
            githubTokens: config.get('githubTokens'),
            gitRefOverrides: config.get('gitRefOverrides'),
            waitRateLimit: true,
            rev: analysis && analysis._rev,
        })
        // Score it to get a "real-time" feeling, ignoring any errors
        .then((analysis) => score(analysis, npmsNano, esClient).catch(() => {}))
        .catch({ code: 'MODULE_NOT_FOUND' }, (err) => score.remove(name, esClient).finally(() => { throw err; }))
        // Ignore unrecoverable errors, so that these are not re-queued
        .catch({ unrecoverable: true }, () => {});
    });
}

// ----------------------------------------------------------------------------

module.exports.builder = (yargs) => {
    return yargs
    .usage('Consumes modules that are queued, triggering the analysis process for each module.\n\nUsage: ./$0 consume [options]')
    .demand(1, 1)
    .option('concurrency', {
        type: 'number',
        default: 5,
        alias: 'c',
        describe: 'Number of modules to consume concurrently',
    })
    .check((argv) => {
        assert(typeof argv.concurrency === 'number', 'Invalid argument: --concurrency must be a number');
        return true;
    });
};

module.exports.handler = (argv) => {
    process.title = 'npms-analyzer-consume';
    log.level = argv.logLevel || 'warn';

    // Allow heapdump via USR2 signal
    process.env.NODE_ENV !== 'test' && require('heapdump');  // eslint-disable-line global-require

    // Prepare DB stuff
    const npmNano = Promise.promisifyAll(nano(config.get('couchdbNpmAddr'), { requestDefaults: { timeout: 15000 } }));
    const npmsNano = Promise.promisifyAll(nano(config.get('couchdbNpmsAddr'), { requestDefaults: { timeout: 15000 } }));
    const esClient = new elasticsearch.Client({ host: config.get('elasticsearchHost'), apiVersion: '2.2', log: null });
    const analysisQueue = queue(config.get('rabbitmqQueue'), config.get('rabbitmqAddr'));

    // Stats
    stats.process();
    stats.queue(analysisQueue);
    stats.progress(npmNano, npmsNano);
    stats.tokens(config.get('githubTokens'), 'github');

    // Start consuming
    analysisQueue.consume((message) => onMessage(message, npmNano, npmsNano, esClient), { concurrency: argv.concurrency });
};