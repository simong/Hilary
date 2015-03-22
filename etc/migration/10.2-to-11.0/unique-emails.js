/*!
 * Copyright 2014 Apereo Foundation (AF) Licensed under the
 * Educational Community License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may
 * obtain a copy of the License at
 *
 *     http://opensource.org/licenses/ECL-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 *
 * This migration script will try to create a mapping between a user's email address and the user
 * object in the Principals table. Before it does that however, the following checks will be made:
 *   -  Ensure that each user has an email address
 *   -  Ensure that each user's email address is valid
 *   -  Ensure that an email address is only used by 1 user
 *
 * A CSV file with all errors will be created in the current working directory. If any of the above
 * checks fail, you will have to manually address these. How you resolve these issues is up to you.
 *
 * Once you've addressed the raised issues, re-run the script to perform the actual migration
 */

var _ = require('underscore');
var bunyan = require('bunyan');
var csv = require('csv');
var fs = require('fs');

var Cassandra = require('oae-util/lib/cassandra');
var log = require('oae-logger').logger('revisions-migrator');
var OAE = require('oae-util/lib/oae');
var PrincipalsDAO = require('oae-principals/lib/internal/dao');
var Validator = require('oae-util/lib/validator').Validator;

// The application configuration
var config = require('../../../config').config;

// Ensure that this application server does NOT start processing any preview images
config.previews.enabled = false;

// Ensure that we're logging to standard out/err
config.log = {
    'streams': [
        {
            'level': 'info',
            'stream': process.stdout
        }
    ]
};

// Keep track of when we started the migration process so we can output how
// long the migration took
var start = Date.now();

// Keep track of whether the persisted email addresses are valid
var persistedEmailAddressesAreValid = true;

// Keep track of the total number of revisions we'll be migrating
var emailsToUsers = {};

// The stream we will be writing to when we detect an invalid or missing email address
var errorFileStream = fs.createWriteStream('./invalid-users.csv', {'encoding': 'utf-8'});

// The `stringify` method returns a stream which we can pipe to the file stream. This allows
// us to write data to the CSV stream and have it automatically piped to the file on disk
var csvStringifier = csv.stringify({
    'header': true,
    'columns': ['principalId', 'displayName', 'email', 'message']
});
csvStringifier.pipe(errorFileStream);

// Spin up the app container. This will allow us to re-use existing APIs
OAE.init(config, function(err) {
    if (err) {
        log().error({'err': err}, 'Unable to spin up the application server');
        return _exit(err.code);
    }

    var oomMessage = 'This migration script will create an in-memory mapping of all the users and ';
    oomMessage += 'their email addresses. If there are too many users in your system, the process ';
    oomMessage += 'will most likely by killed by the OS OOM killer. If this happens, please contact ';
    oomMessage += 'the OAE team and an alternative solution will be provided';
    log().info(oomMessage);

    // Perform a first pass and check whether each user has a valid and unique email address
    _check(function(err) {
        if (err) {
            log().error({'err': err}, 'Unable to check the persisted email addresses');
            return callback(err);
        }

        // Perform a second pass and do the actual mapping
        _createMapping(function(err) {
            if (err) {
                log().error({'err': err}, 'Unable to create the mapping');
                return _exit(err.code);
            }

            log().info('Migration completed, it took %d milliseconds', (Date.now() - start));
            return _exit(0);
        });
    });
});

/**
 * Go through a set of rows and check whether users have a valid email address
 *
 * @param  {Object[]}   principals      An array of principal objects to check
 * @param  {Function}   callback        Standard callback function
 * @param  {Object}     callback.err    An error object, if any
 * @api private
 */
var _checkPrincipals = function(principals, callback) {
    _.each(principals, function(principal) {
        var principalId = principal.principalId;
        var displayName = principal.displayName;
        var email = principal.email;

        // We only care about users in this migration process
        if (!PrincipalsDAO.isUser(principalId)) {
            return;
        }

        // Check if the user event has an email address
        if (!email) {
            persistedEmailAddressesAreValid = false;
            return _logInvalidEmail(principalId, displayName, email, 'This user has no email address');
        }

        // Check whether the persisted email address is valid
        var validator = new Validator();
        validator.check(email, {'code': 400, 'msg': 'An invalid email address has been persisted'}).isEmail();
        if (validator.hasErrors()) {
            persistedEmailAddressesAreValid = false;
            return _logInvalidEmail(principalId, displayName, email, 'This user has an invalid email address');
        }

        // Keep track of the email addresses. We don't check for uniqueness here yet. We first
        // iterate through all the records and then go through the entire set again. This allows
        // us to generate a full list of principal IDs against an email address in case an address
        // is re-used
        emailsToUsers[email] = emailsToUsers[email] || [];
        emailsToUsers[email].push({'id': principalId, 'displayName': displayName});
    });

    // Move on to the next set of principals
    return callback();
};

/**
 * Go through the entire Principals column family and check whether each user has
 * a valid and unique email address
 *
 * @param  {Function}   callback        Standard callback function
 * @param  {Object}     callback.err    An error that occurred, if any
 * @api private
 */
var _check = function(callback) {
    var msg = 'This script will write the id, tenant alias, name and email of the users whose ';
    msg += 'email address are either invalid or missing to a CSV file called "invalid-users.csv" in ';
    msg += 'the current working directory';
    log().info(msg);

    // Check whether the persisted email addresses are valid
    log().info('Checking whether the persisted email addresses are valid');
    PrincipalsDAO.iterateAll(['principalId', 'displayName', 'email'], 30, _checkPrincipals, function(err) {
        if (err) {
            return callback(err);
        }

        // Check whether each email address is unique
        log().info('Checking whether the persisted email addresses are unique');
        var persistedEmailAddressesAreUnique = true;
        _.each(emailsToUsers, function(users, email) {
            if (users.length !== 1) {
                persistedEmailAddressesAreUnique = false;

                // Write a record to the CSV file
                var principalIds = _.pluck(users, 'id').join(' - ');
                var displayNames = _.pluck(users, 'displayName').join(' - ');
                _logInvalidEmail(principalIds, displayNames, email, 'Duplicate email addresses detected');
            }
        });

        // If an email address is either invalid, missing or linked with multiple users, we bail out
        if (!persistedEmailAddressesAreValid || !persistedEmailAddressesAreUnique) {
            log().error('Not all persisted email addresses are valid or unique. Please fix the raised issues before continuing');
            return _exit(1);
        }

        return callback();
    });
};

/**
 * Create the mapping between emails and users
 *
 * @param  {Function}   callback            Standard callback function
 * @param  {Object}     callback.err        An error object, if any
 * @api private
 */
var _createMapping = function(callback) {
    log().info('Starting migration process, please be patient as this might take a while');
    log().info('The process will exit when the migration has been completed');

    // At this point we know that each email address points to one unique user. Generate a structure
    // that is slightly easier to persist into Cassandra
    var users = _.map(emailsToUsers, function(users, email) {
        return {'email': email, 'id': users[0].id};
    });

    // Persist the actual mapping
    _createEmailMapping(users, callback);
};

/**
 * Create the mapping between emails and users for a set of users
 *
 * @param  {Object[]}   users               The set of users for whom to create the mapping. Each object should contain an `email` and `id`
 * @param  {Function}   callback            Standard callback function
 * @param  {Object}     callback.err        An error object, if any
 * @api private
 */
var _createEmailMapping = function(users, callback) {
    if (_.isEmpty(users)) {
        return callback();
    }

    // Slice off 30 users for which to create the mapping. Don't try and do all users in one go as
    // that could potentially result in a couple of hundred thousand queries. This kills Cassandra
    var usersToMap = users.splice(0, 30);
    var queries = _.map(usersToMap, function(user) {
        return Cassandra.constructUpsertCQL('PrincipalsByEmail', 'email', user.email, {'principalId': user.id});
    });

    Cassandra.runBatchQuery(queries, function(err) {
        if (err) {
            return callback(err);
        }

        _createEmailMapping(users, callback);
    });
};

/**
 * Wrap process.exit to ensure we've logged all the error messages to the CSV file
 *
 * @param  {Number}     code    The code with which we should exit the process
 * @api private
 */
var _exit = function(code) {
    // Closing the CSV stream will bubble up to the file stream and close that one as well. We do
    // this so we're sure all records are flushed to disk before exiting
    errorFileStream.on('close', function() {
        process.exit(code);
    });
    csvStringifier.end();
};

/**
 * Write a record to the CSV file indicating something is wrong for a principal
 *
 * @param  {String}     principalId     The id of the principal for whom something is wrong
 * @param  {String}     displayName     The name of the principal for whom something is wrong
 * @param  {String}     email           The email address, if any
 * @param  {String}     message         An error message describing what's wrong
 */
var _logInvalidEmail = function(principalId, displayName, email, message) {
    csvStringifier.write({
        'principalId': principalId,
        'displayName': displayName,
        'email': email,
        'message': message
    });
};
