// Copyright (c) 2017-2019, The Particl Market developers
// Distributed under the GPL software license, see the accompanying
// file COPYING or https://github.com/particl/particl-market/blob/develop/LICENSE

import * as Bookshelf from 'bookshelf';
import * as _ from 'lodash';
import * as resources from 'resources';
import { inject, named } from 'inversify';
import { Logger as LoggerType } from '../../../core/Logger';
import { Types, Core, Targets } from '../../../constants';
import { validate, request } from '../../../core/api/Validate';
import { NotFoundException } from '../../exceptions/NotFoundException';
import { IdentityRepository } from '../../repositories/IdentityRepository';
import { Identity } from '../../models/Identity';
import { IdentityCreateRequest } from '../../requests/model/IdentityCreateRequest';
import { IdentityUpdateRequest } from '../../requests/model/IdentityUpdateRequest';
import { SettingService } from './SettingService';
import { IdentityType } from '../../enums/IdentityType';
import { ModelNotFoundException } from '../../exceptions/ModelNotFoundException';
import { ProfileService } from './ProfileService';
import { RpcExtKey, RpcExtKeyResult, RpcMnemonic, RpcWallet, RpcWalletInfo } from 'omp-lib/dist/interfaces/rpc';
import { MessageException } from '../../exceptions/MessageException';
import { CoreRpcService } from '../CoreRpcService';

export class IdentityService {

    public log: LoggerType;

    constructor(
        @inject(Types.Repository) @named(Targets.Repository.IdentityRepository) public identityRepository: IdentityRepository,
        @inject(Types.Service) @named(Targets.Service.model.SettingService) public settingService: SettingService,
        @inject(Types.Service) @named(Targets.Service.model.ProfileService) public profileService: ProfileService,
        @inject(Types.Service) @named(Targets.Service.CoreRpcService) public coreRpcService: CoreRpcService,
        @inject(Types.Core) @named(Core.Logger) public Logger: typeof LoggerType
    ) {
        this.log = new Logger(__filename);
    }

    public async findAll(): Promise<Bookshelf.Collection<Identity>> {
        return this.identityRepository.findAll();
    }

    public async findAllByProfileId(profileId: number, withRelated: boolean = true): Promise<Bookshelf.Collection<Identity>> {
        return await this.identityRepository.findAllByProfileId(profileId, withRelated);
    }

    public async findOne(id: number, withRelated: boolean = true): Promise<Identity> {
        const identity = await this.identityRepository.findOne(id, withRelated);
        if (identity === null) {
            this.log.warn(`Identity with the id=${id} was not found!`);
            throw new NotFoundException(id);
        }
        return identity;
    }

    public async findOneByWalletName(wallet: string, withRelated: boolean = true): Promise<Identity> {
        const identity = await this.identityRepository.findOneByWalletName(wallet, withRelated);
        if (identity === null) {
            this.log.warn(`Identity with the wallet=${wallet} was not found!`);
            throw new NotFoundException(wallet);
        }
        return identity;
    }

    public async findOneByAddress(address: string, withRelated: boolean = true): Promise<Identity> {
        const identity = await this.identityRepository.findOneByAddress(address, withRelated);
        if (identity === null) {
            this.log.warn(`Identity with the address=${address} was not found!`);
            throw new NotFoundException(address);
        }
        return identity;
    }

    public async findProfileIdentity(profileId: number, withRelated: boolean = true): Promise<Identity> {
        const profile: resources.Profile = await this.profileService.findOne(profileId, true).then(value => value.toJSON());
        const identity: resources.Identity | undefined = _.find(profile.Identities, p => {
            return p.type === IdentityType.PROFILE;
        });
        if (!identity) {
            this.log.warn(`Profile with the id=${profileId} has no Identity!`);
            throw new ModelNotFoundException('Identity');
        }
        return await this.identityRepository.findOne(identity.id, withRelated);
    }

    @validate()
    public async create( @request(IdentityCreateRequest) data: IdentityCreateRequest): Promise<Identity> {
        // this.log.debug('create(): ', JSON.stringify(data, null, 2));
        const body = JSON.parse(JSON.stringify(data));
        return await this.identityRepository.create(body);
    }

    /**
     * create a new Identity for Market
     *
     * @param profile
     */
    public async createMarketIdentityForProfile(profile: resources.Profile): Promise<Identity> {

        // first get the Profile Identity
        const profileIdentity: resources.Identity = await this.findProfileIdentity(profile.id).then(value => value.toJSON());

        const extKeys: RpcExtKey[] = await this.coreRpcService.extKeyList(profileIdentity.wallet, true);
        const masterKey: RpcExtKey | undefined = _.find(extKeys, key => {
            return key.type === 'Loose' && key.key_type === 'Master' && key.label === 'Master Key - bip44 derived.' && key.current_master === 'true';
        });

        if (!masterKey) {
            throw new MessageException('Could not find Profile wallets Master key.');
        }

        const keyInfo: RpcExtKeyResult = await this.coreRpcService.extKeyInfo(profileIdentity.wallet, masterKey.evkey, "4444446'/0'");

        // create and load a new blank wallet
        const walletName = 'profiles/' + profile.name + '/particl-market';
        const marketWallet: RpcWallet = await this.coreRpcService.createAndLoadWallet(walletName, false, true);

        // import the key and set up the market wallet
        const extKeyAlt: string = await this.coreRpcService.extKeyAltVersion(masterKey.evkey);
        const extKeyImported: RpcExtKeyResult = await this.coreRpcService.extKeyImport(marketWallet.name, masterKey.evkey, 'master key', true);
        await this.coreRpcService.extKeySetMaster(marketWallet.name, extKeyImported.id);
        const marketAccount: RpcExtKeyResult = await this.coreRpcService.extKeyDeriveAccount(marketWallet.name, 'market account');
        await this.coreRpcService.extKeySetDefaultAccount(marketWallet.name, marketAccount.account);

        const address = await this.coreRpcService.getNewAddress(marketWallet.name);
        const walletInfo: RpcWalletInfo = await this.coreRpcService.getWalletInfo(marketWallet.name);

        // create Identity for Market, using the created wallet
        return await this.create({
            profile_id: profile.id,
            wallet: marketWallet.name,
            address,
            hdseedid: walletInfo.hdseedid,
            path: keyInfo.key_info.path,
            type: IdentityType.MARKET
        } as IdentityCreateRequest);
    }

    /**
     * create an Identity for Profile:
     * - create and load a new blank wallet
     * - create a new mnemonic
     * - import master key from bip44 mnemonic root key and derive default account
     *
     * @param profile
     */
    public async createProfileIdentity(profile: resources.Profile): Promise<Identity> {

        // create and load a new blank wallet
        const walletName = 'profiles/' + profile.name;
        const wallet: RpcWallet = await this.coreRpcService.createAndLoadWallet(walletName, false, true);

        // create a new mnemonic
        const passphrase = this.createRandom();
        const mnemonic: RpcMnemonic = await this.coreRpcService.mnemonic(['new', passphrase, 'english', 32, true]);

        // import master key from bip44 mnemonic root key and derive default account
        await this.coreRpcService.extKeyGenesisImport(wallet.name, [mnemonic.mnemonic, passphrase]);

        const extKeys: RpcExtKey[] = await this.coreRpcService.extKeyList(wallet.name, true);
        const masterKey: RpcExtKey | undefined = _.find(extKeys, key => {
            return key.type === 'Loose' && key.key_type === 'Master' && key.label === 'Master Key - bip44 derived.' && key.current_master === 'true';
        });
        if (!masterKey) {
            throw new MessageException('Could not find Profile wallets Master key.');
        }
        // const keyInfo: RpcExtKeyResult = await this.coreRpcService.extKeyInfo(wallet.name, masterKey.evkey, "4444446'/0'");

        const address = await this.coreRpcService.getNewAddress(wallet.name);
        const walletInfo: RpcWalletInfo = await this.coreRpcService.getWalletInfo(walletName);

        // create Identity for Profile, using the created wallet
        return await this.create({
            profile_id: profile.id,
            wallet: wallet.name,
            address,
            hdseedid: walletInfo.hdseedid,
            path: masterKey.path,
            mnemonic: mnemonic.mnemonic,
            passphrase,
            type: IdentityType.PROFILE
        } as IdentityCreateRequest);
    }


    @validate()
    public async update(id: number, @request(IdentityUpdateRequest) body: IdentityUpdateRequest): Promise<Identity> {

        const identity = await this.findOne(id, false);
        identity.Wallet = body.wallet;
        identity.Address = body.address;
        identity.Hdseedid = body.hdseedid;
        identity.Path = body.hdseedid;
        identity.Mnemonic = body.mnemonic;
        identity.Passphrase = body.passphrase;
        identity.Type = body.type;

        const updatedIdentity = await this.identityRepository.update(id, identity.toJSON());
        return updatedIdentity;
    }

    public async destroy(id: number): Promise<void> {
        await this.identityRepository.destroy(id);
    }

    /**
     * todo: move to some util
     */
    private createRandom(length: number = 24, caps: boolean = true, lower: boolean = true, numbers: boolean = true, unique: boolean = true): string {
        const capsChars = caps ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] : [];
        const lowerChars = lower ? [...'abcdefghijklmnopqrstuvwxyz'] : [];
        const numChars = numbers ? [...'0123456789'] : [];
        const uniqueChars = unique ? [...'~!@#$%^&*()_+-=[]{};:,.<>?'] : [];
        const selectedChars = [...capsChars, ...lowerChars, ...numChars, ...uniqueChars];

        return [...Array(length)]
            .map(i => selectedChars[Math.random() * selectedChars.length | 0])
            .join('');
    }

}