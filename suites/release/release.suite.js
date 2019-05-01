/*
 * Copyright 2018 balena
 *
 * @license Apache-2.0
 */

'use strict';

const noop = require('lodash/noop');
const Bluebird = require('bluebird');
const fse = require('fs-extra');
const { join } = require('path');
const { homedir } = require('os');

module.exports = [
  {
    setup: async function() {
      const Worker = require(join(this.frameworkPath, 'workers', this.options.worker.type));
      const BalenaOS = require(join(this.frameworkPath, 'components', 'os', 'balenaos'));
      const Balena = require(join(this.frameworkPath, 'components', 'balena', 'sdk'));

      this.context = { utils: require(join(this.frameworkPath, 'common', 'utils')) };

      fse.ensureDirSync(this.options.tmpdir);
      this.context = {
        deviceType: require(join(
          this.frameworkPath,
          '..',
          'contracts',
          'contracts',
          'hw.device-type',
          this.options.deviceType,
          'contract.json'
        ))
      };

      this.context = { sshKeyPath: join(homedir(), 'id') };

      this.context = { balena: { sdk: new Balena(this.options.balena.apiUrl) } };

      await this.context.balena.sdk.loginWithToken(this.options.balena.apiKey);
      this.teardown.register(() => {
        return this.context.balena.sdk.logout().catch(
          {
            code: 'BalenaNotLoggedIn'
          },
          noop
        );
      });

      this.context = { balena: { application: this.options.balena.application } };

      await this.context.balena.sdk.createApplication(
        this.context.balena.application.name,
        this.context.deviceType.slug,
        {
          delta: this.context.balena.application.env.delta
        }
      );
      this.teardown.register(() => {
        return this.context.balena.sdk
          .removeApplication(this.context.balena.application.name)
          .catch(
            {
              code: 'BalenaNotLoggedIn'
            },
            noop
          )
          .catch(
            {
              code: 'BalenaApplicationNotFound'
            },
            noop
          );
      });

      await this.context.balena.sdk.addSSHKey(
        this.options.balena.sshKeyLabel,
        await this.context.utils.createSSHKey(this.context.sshKeyPath)
      );
      this.teardown.register(() => {
        return Bluebird.resolve(
          this.context.balena.sdk.removeSSHKey(this.options.balena.sshKeyLabel)
        ).catch(
          {
            code: 'BalenaNotLoggedIn'
          },
          noop
        );
      });

      this.context = { balena: { uuid: await this.context.balena.sdk.generateUUID() } };
      this.context = {
        os: new BalenaOS({
          deviceType: this.context.deviceType.slug,
          download: {
            type: this.options.balenaOS.download.type,
            version: this.options.balenaOS.download.version,
            source: this.options.balenaOS.download.source
          },
          network: this.options.balenaOS.network
        })
      };

      this.context = {
        worker: new Worker('main worker', this.context.deviceType.slug, {
          devicePath: this.options.worker.device
        })
      };

      await this.context.os.fetch(this.options.tmpdir);

      this.context.os.addCloudConfig(
        await this.context.balena.sdk.getDeviceOSConfiguration(
          this.context.balena.uuid,
          await this.context.balena.sdk.register(
            this.context.balena.application.name,
            this.context.balena.uuid
          ),
          this.context.os.image.version
        )
      );

      this.context = {
        balena: { sync: require(join(this.frameworkPath, 'components', 'balena', 'sync')) }
      };

      await this.context.worker.ready();
      await this.context.worker.flash(this.context.os);
      await this.context.worker.on();
      this.teardown.register(() => {
        return this.context.worker.off();
      });

      console.log('Waiting for device to be online');
      await this.context.utils.waitUntil(() => {
        return this.context.balena.sdk.isDeviceOnline(this.context.balena.uuid);
      });
    },
    tests: ['register']
  }
];