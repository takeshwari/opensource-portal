//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

const express = require('express');
const router = express.Router();

const async = require('async');
const emailRender = require('../../../lib/emailRender');
const lowercaser = require('../../../middleware/lowercaser');
const orgPermissions = require('../../../middleware/github/orgPermissions');
const teamMaintainerRoute = require('./index-maintainer');
const teamPermissionsMiddleware = require('../../../middleware/github/teamPermissions');
const utils = require('../../../utils');

router.use((req, res, next) => {
  const oss = req.oss;
  const login = oss.usernames.github;
  const team2 = req.team2;
  team2.getMembershipEfficiently(login, (getMembershipError, membership) => {
    if (getMembershipError) {
      return next(getMembershipError);
    }
    req.membershipStatus = membership;
    return next();
  });
});

router.use('/join', orgPermissions, (req, res, next) => {
  const organization = req.organization;
  const team2 = req.team2;
  const orgPermissions = req.orgPermissions;

  // Are they already a team member?
  const currentMembershipStatus = req.membershipStatus;
  if (currentMembershipStatus) {
    return next(utils.wrapError(null, `You are already a ${currentMembershipStatus} of the ${team2.name} team`, true));
  }

  // Have they joined the organization yet?
  const membershipStatus = orgPermissions.membershipStatus;
  let error = null;
  if (membershipStatus !== 'active') {
    error = new Error(`You are not a member of the ${organization.name} GitHub organization.`);
    error.title = 'Please join the organization before joining this team';
    error.detailed = membershipStatus === 'pending' ? 'You have not accepted your membership yet, or do not have two-factor authentication enabled.' : 'After you join the organization, you can join this team.';
    error.skipOops = true;
    error.skipLog = true;
    error.fancyLink = {
      link: `/${organization.name}`,
      title: `Join the ${organization.name} organization`,
    };
  }
  return next(error);
});

router.get('/join', function (req, res, next) {
  const team = req.team;
  const oss = req.oss;

  // The broad access "all members" team is always open for automatic joining without
  // approval. This short circuit is to show that option.
  if (team.org.getAllMembersTeam().id === team.id) {
    return oss.render(req, res, 'org/team/join', `Join ${team.name}`, {
      team: team,
      allowSelfJoin: true,
    });
  }

  // This maintainer custom logic code is only in the legacy 'team' at this time
  team.getOfficialMaintainers((getMaintainersError, maintainers) => {
    if (getMaintainersError) {
      return next(getMaintainersError);
    }
    req.oss.render(req, res, 'org/team/join', `Join ${team.name}`, {
      team: team,
      teamMaintainers: maintainers,
    });
  });
});

router.post('/join', function (req, res, next) {
  const config = req.app.settings.runtimeConfig;
  const oss = req.oss;
  const org = req.org;
  const team = req.team;
  if (org.getAllMembersTeam().id === team.id) {
    return team.addMembership('member', function (error) {
      if (error) {
        req.insights.trackEvent('GitHubJoinAllMembersTeamFailure', {
          org: org.name,
          username: req.oss.usernames.github,
          error: error.message,
        });
        return next(utils.wrapError(error, `We had trouble adding you to the ${org.name} organization. ${req.oss.usernames.github}`));
      }
      req.oss.saveUserAlert(req, `You have joined ${team.name} team successfully`, 'Join Successfully', 'success');
      req.insights.trackEvent('GitHubJoinAllMembersTeamSuccess', {
        org: org.name,
        username: req.oss.usernames.github
      });
      return res.redirect(`${org.baseUrl}teams`);
    });
  }

  const justification = req.body.justification;
  if (justification === undefined || justification === '') {
    return next(utils.wrapError(null, 'You must include justification for your request.', true));
  }
  const approvalTypesValues = config.github.approvalTypes.repo;
  if (approvalTypesValues.length === 0) {
    return next(new Error('No team join approval providers configured.'));
  }
  const approvalTypes = new Set(approvalTypesValues);
  const mailProviderInUse = approvalTypes.has('mail');
  let issueProviderInUse = approvalTypes.has('github');
  if (!mailProviderInUse && !issueProviderInUse) {
    return next(new Error('No configured approval providers configured.'));
  }
  const mailProvider = req.app.settings.mailProvider;
  const approverMailAddresses = [];
  if (mailProviderInUse && !mailProvider) {
    return next(utils.wrapError(null, 'No mail provider is enabled, yet this application is configured to use a mail provider.'));
  }
  const mailAddressProvider = req.app.settings.mailAddressProvider;
  let notificationsRepo = null;
  try {
    notificationsRepo = issueProviderInUse ? org.getWorkflowRepository() : null;
  } catch (noWorkflowRepo) {
    notificationsRepo = false;
    issueProviderInUse = false;
  }
  const displayHostname = req.hostname;
  const approvalScheme = displayHostname === 'localhost' && config.webServer.allowHttp === true ? 'http' : 'https';
  const reposSiteBaseUrl = `${approvalScheme}://${displayHostname}/`;
  const approvalBaseUrl = `${reposSiteBaseUrl}approvals/`;
  const personName = oss.modernUser().contactName();
  let personMail = null;
  const dc = oss.dataClient();
  let assignTo = null;
  let requestId = null;
  let allMaintainers = null;
  let issueNumber = null;
  let approvalRequest = null;
  async.waterfall([
    function getRequesterEmailAddress(callback) {
      const upn = oss.modernUser().contactEmail();
      mailAddressProvider.getAddressFromUpn(upn, (resolveError, mailAddress) => {
        if (resolveError) {
          return callback(resolveError);
        }
        personMail = mailAddress;
        callback();
      });
    },
    function (callback) {
      team.isMember(callback);
    },
    function (isMember, callback) {
      if (isMember === true) {
        return next(utils.wrapError(null, 'You are already a member of the team ' + team.name, true));
      }
      team.getOfficialMaintainers(callback);
    },
    (maintainers, callback) => {
      async.filter(maintainers, (maintainer, filterCallback) => {
        filterCallback(null, maintainer && maintainer.login && maintainer.link);
      }, callback);
    },
    function (maintainers, callback) {
      approvalRequest = {
        ghu: oss.usernames.github,
        ghid: oss.id.github,
        justification: req.body.justification,
        requested: ((new Date()).getTime()).toString(),
        active: false,
        type: 'joinTeam',
        org: team.org.name,
        teamid: team.id,
        teamname: team.name,
        email: oss.modernUser().contactEmail(),
        name: oss.modernUser().contactName(),
      };
      const randomMaintainer = maintainers[Math.floor(Math.random() * maintainers.length)];
      assignTo = randomMaintainer ? randomMaintainer.login : '';
      const mnt = [];
      async.each(maintainers, (maintainer, next) => {
        mnt.push('@' + maintainer.login);
        const approverUpn = maintainer && maintainer.link && maintainer.link.aadupn ? maintainer.link.aadupn : null;
        if (approverUpn) {
          mailAddressProvider.getAddressFromUpn(approverUpn, (getAddressError, mailAddress) => {
            if (getAddressError) {
              return next(getAddressError);
            }
            approverMailAddresses.push(mailAddress);
            next();
          });
        } else {
          next();
        }
      }, (addressResolutionError) => {
        if (addressResolutionError) {
          return callback(addressResolutionError);
        }
        allMaintainers = mnt.join(', ');
        dc.insertApprovalRequest(team.id, approvalRequest, callback);
      });
    },
    function (newRequestId) {
      const callback = arguments[arguments.length - 1];
      requestId = newRequestId;
      if (!issueProviderInUse) {
        return callback();
      }
      const body = 'A team join request has been submitted by ' + oss.modernUser().contactName() + ' (' +
        oss.modernUser().contactEmail() + ', [' + oss.usernames.github + '](' +
        'https://github.com/' + oss.usernames.github + ')) to join your "' +
        team.name + '" team ' + 'in the "' + team.org.name + '" organization.' + '\n\n' +
        allMaintainers + ': Can a team maintainer [review this request now](' +
        'https://' + req.hostname + '/approvals/' + requestId + ')?\n\n' +
        '<em>If you use this issue to comment with the team maintainers, please understand that your comment will be visible by all members of the organization.</em>';
      notificationsRepo.createIssue({
        title: 'Request to join team "' + team.org.name + '/' + team.name + '" by ' + oss.usernames.github,
        body: body,
      }, callback);
    },
    function (issue) {
      const callback = arguments[arguments.length - 1];
      const itemUpdates = {
        active: true,
      };
      if (issueProviderInUse) {
        if (issue.id && issue.number) {
          issueNumber = issue.number;
          itemUpdates.issueid = issue.id.toString();
          itemUpdates.issue = issue.number.toString();
        } else {
          return callback(new Error('An issue could not be created. The response object representing the issue was malformed.'));
        }
      }
      dc.updateApprovalRequest(requestId, itemUpdates, callback);
    },
    function setAssignee() {
      req.oss.saveUserAlert(req, 'Your request to join ' + team.name + ' has been submitted and will be reviewed by a team maintainer.', 'Permission Request', 'success');
      const callback = arguments[arguments.length - 1];
      if (!issueProviderInUse) {
        return callback();
      }
      notificationsRepo.updateIssue(issueNumber, {
        assignee: assignTo,
      }, function (error) {
        if (error) {
          // CONSIDER: Log. This error condition hits when a user has
          // been added to the org outside of the portal. Since they
          // are not associated with the workflow repo, they cannot
          // be assigned by GitHub - which throws a validation error.
        }
        callback();
      });
    },
    function sendApproverMail() {
      const callback = arguments[arguments.length - 1];
      if (!mailProviderInUse) {
        return callback();
      }
      const approversAsString = approverMailAddresses.join(', ');
      const mail = {
        to: approverMailAddresses,
        subject: `${personName} wants to join your ${team.name} team in the ${team.org.name} GitHub org`,
        reason: (`You are receiving this e-mail because you are a team maintainer for the GitHub team "${team.name}" in the ${team.org.name} organization.
                  To stop receiving these mails, you can remove your team maintainer status on GitHub.
                  This mail was sent to: ${approversAsString}`),
        headline: `${team.name} permission request`,
        classification: 'action',
        service: 'Microsoft GitHub',
        correlationId: req.correlationId,
      };
      const contentOptions = {
        correlationId: req.correlationId,
        version: config.logging.version,
        actionUrl: approvalBaseUrl + requestId,
        reposSiteUrl: reposSiteBaseUrl,
        approvalRequest: approvalRequest,
        team: team.name,
        org: team.org.name,
        personName: personName,
        personMail: personMail,
      };
      emailRender.render(req.app.settings.basedir, 'membershipApprovals/pleaseApprove', contentOptions, (renderError, mailContent) => {
        if (renderError) {
          req.insights.trackException(renderError, {
            content: contentOptions,
            eventName: 'ReposTeamRequestPleaseApproveMailRenderFailure',
          });
          return callback(renderError);
        }
        mail.content = mailContent;
        mailProvider.sendMail(mail, (mailError, mailResult) => {
          const customData = {
            content: contentOptions,
            receipt: mailResult,
          };
          if (mailError) {
            customData.eventName = 'ReposTeamRequestPleaseApproveMailFailure';
            req.insights.trackException(mailError, customData);
            return callback(mailError);
          }
          req.insights.trackEvent('ReposTeamRequestPleaseApproveMailSuccess', customData);
          dc.updateApprovalRequest(requestId, {
            mailSentToApprovers: approversAsString,
            mailSentTo: personMail,
          }, callback);
        });
      });
    },
    function sendRequesterMail() {
      const callback = arguments[arguments.length - 1];
      if (!mailProviderInUse) {
        return callback();
      }
      // Let's send e-mail to the requester about this action
      const mail = {
        to: personMail,
        subject: `Your ${team.org.name} "${team.name}" permission request has been submitted`,
        reason: (`You are receiving this e-mail because you requested to join this team.
                  This mail was sent to: ${personMail}`),
        headline: 'Team request submitted',
        classification: 'information',
        service: 'Microsoft GitHub',
        correlationId: req.correlationId,
      };
      const contentOptions = {
        correlationId: req.correlationId,
        version: config.logging.version,
        actionUrl: approvalBaseUrl + requestId,
        reposSiteUrl: reposSiteBaseUrl,
        approvalRequest: approvalRequest,
        team: team.name,
        org: team.org.name,
        personName: personName,
        personMail: personMail,
      };
      emailRender.render(req.app.settings.basedir, 'membershipApprovals/requestSubmitted', contentOptions, (renderError, mailContent) => {
        if (renderError) {
          req.insights.trackException(renderError, {
            content: contentOptions,
            eventName: 'ReposTeamRequestSubmittedMailRenderFailure',
          });
          return callback(renderError);
        }
        mail.content = mailContent;
        mailProvider.sendMail(mail, (mailError, mailResult) => {
          const customData = {
            content: contentOptions,
            receipt: mailResult,
          };
          if (mailError) {
            customData.eventName = 'ReposTeamRequestSubmittedMailFailure';
            req.insights.trackException(mailError, customData);
            return callback(mailError);
          }
          req.insights.trackEvent('ReposTeamRequestSubmittedMailSuccess', customData);
          callback();
        });
      });
    },
  ], function (error) {
    if (error) {
      return next(error);
    }
    res.redirect(team.org.baseUrl);
  });
});

// Adds "req.teamPermissions", "req.teamMaintainers" middleware
router.use(teamPermissionsMiddleware);

// The view uses this information today to show the sudo banner
router.use((req, res, next) => {
  if (req.teamPermissions.sudo === true) {
    req.sudoMode = true;
  }
  return next();
});

router.get('/', orgPermissions, (req, res, next) => {
  const oss = req.oss;
  const id = oss.id.github ? parseInt(oss.id.github, 10) : null;
  const teamPermissions = req.teamPermissions;
  const membershipStatus = req.membershipStatus;
  const team2 = req.team2;
  const legacyTeam = req.team;
  const operations = req.app.settings.operations;
  const organization = req.organization;

  const teamMaintainers = req.teamMaintainers;
  const maintainersSet = new Set();
  for (let i = 0; i < teamMaintainers.length; i++) {
    maintainersSet.add(teamMaintainers[i].id);
  }

  let membersFirstPage = [];
  let teamDetails = null;
  let repositories = null;

  const isBroadAccessTeam = team2.isBroadAccessTeam;
  const isSystemTeam = team2.isSystemTeam;

  const orgOwnersSet = req.orgOwnersSet;
  let isOrgOwner = orgOwnersSet ? orgOwnersSet.has(id) : false;

  function renderPage() {
    oss.render(req, res, 'org/team/index', team2.name, {
      team: legacyTeam,
      teamUrl: req.teamUrl, // ?
      employees: [], // data.employees,
      pendingApprovals: [], // data.pendingApprovals,

      // changed implementation:
      maintainers: teamMaintainers,
      maintainersSet: maintainersSet,

      // new values:
      teamPermissions: teamPermissions,
      membershipStatus: membershipStatus,
      membersFirstPage: membersFirstPage,
      team2: team2,
      teamDetails: teamDetails,
      organization: organization,
      isBroadAccessTeam: isBroadAccessTeam,
      isSystemTeam: isSystemTeam,
      repositories: repositories,
      isOrgOwner: isOrgOwner,
      orgOwnersSet: orgOwnersSet,
    });
  }

  // Get the first page (by 100) of members, we only show a subset
  const firstPageOptions = {
    pageLimit: 1,
    backgroundRefresh: true,
    maxAgeSeconds: 60,
  };
  team2.getMembers(firstPageOptions, (getMembersError, membersSubset) => {
    if (getMembersError) {
      return next(getMembersError);
    }
    membersFirstPage = membersSubset;

    team2.getDetails((detailsError, details) => {
      if (detailsError) {
        return next(detailsError);
      }
      teamDetails = details;

      const onlySourceRepositories = {
        type: 'sources',
      };
      team2.getRepositories(onlySourceRepositories, (reposError, reposWithPermissions) => {
        if (reposError) {
          return next(reposError);
        }
        repositories = reposWithPermissions.sort(sortByNameCaseInsensitive);

        operations.getLinks((getLinksError, links) => {
          if (getLinksError) {
            return next(getLinksError);
          }
          const map = new Map();
          for (let i = 0; i < links.length; i++) {
            const id = links[i].ghid;
            if (id) {
              map.set(parseInt(id, 10), links[i]);
            }
          }

          async.parallel([
            callback => {
              addLinkToList(teamMaintainers, map);
              return resolveMailAddresses(operations, teamMaintainers, callback);
            },
            callback => {
              addLinkToList(membersFirstPage, map);
              return resolveMailAddresses(operations, membersFirstPage, callback);
            },
          ], (parallelError) => {
            if (parallelError) {
              return next(parallelError);
            }
            return renderPage();
          });
        });
      });
    });
  });
});

function addLinkToList(array, linksMap) {
  for (let i = 0; i < array.length; i++) {
    const entry = array[i];
    const link = linksMap.get(entry.id);
    if (link) {
      entry.link = link;
    }
  }
}

function resolveMailAddresses(operations, array, callback) {
  const mailAddressProvider = operations.mailAddressProvider;
  if (!mailAddressProvider) {
    return callback();
  }

  async.eachLimit(array, 5, (entry, next) => {
    const upn = entry && entry.link ? entry.link.aadupn : null;
    if (!upn) {
      return next();
    }
    mailAddressProvider.getAddressFromUpn(upn, (resolveError, mailAddress) => {
      if (!resolveError && mailAddress) {
        entry.mailAddress = mailAddress;
      }
      return next();
    });
  }, callback);
}

function sortByNameCaseInsensitive(a, b) {
  let nameA = a.name.toLowerCase();
  let nameB = b.name.toLowerCase();
  if (nameA < nameB) {
    return -1;
  }
  if (nameA > nameB) {
    return 1;
  }
  return 0;
}

router.use('/members', require('./members'));
router.get('/repos', lowercaser(['sort', 'language', 'type', 'tt']), require('../../reposPager'));
router.use('/delete', require('./delete'));
router.use('/properties', require('./properties'));
router.use('/maintainers', require('./maintainers'));

router.use(teamMaintainerRoute);

module.exports = router;
