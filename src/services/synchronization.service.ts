import {Inject, Injectable} from "@angular/core";
import {ILIASObject} from "../models/ilias-object";
import {DataProvider} from "../providers/data-provider.provider";
import {User} from "../models/user";
import {SQLiteDatabaseService} from "./database.service";
import {FileService} from "./file.service";
import {Events} from "ionic-angular";
import {FooterToolbarService, Job} from "./footer-toolbar.service";
import {TranslateService} from "ng2-translate/src/translate.service";
import {Log} from "./log.service";
import {FileData} from "../models/file-data";
import {NEWS_SYNCHRONIZATION, NewsSynchronization} from "./news/news.synchronization";
import {
  VISIT_JOURNAL_SYNCHRONIZATION,
  VisitJournalSynchronization
} from "../learnplace/services/visitjournal.service";
import {LEARNPLACE_LOADER, LearnplaceLoader} from "../learnplace/services/loader/learnplace";
import {Observable} from "rxjs/Observable";
import {Favorites} from "../models/favorites";

export interface SynchronizationState {
    liveLoading: boolean,
    loadingOfflineContent: boolean,
    recursiveSyncRunning: boolean
}
interface SyncEntry {
    object: ILIASObject,
    resolver: Resolve<SyncResults>,
    rejecter: Reject<Error>
}

@Injectable()
export class SynchronizationService {

    static state: SynchronizationState = {
        liveLoading: false,
        loadingOfflineContent: false,
        recursiveSyncRunning: false
    };
    readonly footerToolbarOfflineContent: FooterToolbarService = new FooterToolbarService();

    private user: User;

    private syncOfflineQueue: Array<ILIASObject> = [];
    private syncOfflineQueueCnt: number = 0;
    private recursiveSyncQueue: Array<SyncEntry> = [];

    lastSync: Date;
    lastSyncString: string;

    constructor(private readonly dataProvider: DataProvider,
                public events: Events,
                private readonly fileService: FileService,
                private readonly footerToolbar: FooterToolbarService,
                private readonly translate: TranslateService,
                @Inject(NEWS_SYNCHRONIZATION) private readonly newsSynchronization: NewsSynchronization,
                @Inject(VISIT_JOURNAL_SYNCHRONIZATION) private readonly visitJournalSynchronization: VisitJournalSynchronization,
                @Inject(LEARNPLACE_LOADER) private readonly learnplaceLoader: LearnplaceLoader
    ) {}

    /**
     * Execute synchronization
     * If iliasObject is undefined, executes sync for desktop-data
     * If iliasObject is given, only fetches data for the given object
     * @param iliasObject
     * @returns Promise<Array<ILIASObject>>
     */
    liveLoad(iliasObject?: ILIASObject): Promise<Array<ILIASObject>> {
        SynchronizationService.state.liveLoading = true;

        return this.loadCurrentUser()
            .then(() => {
                return this.syncStarted()
                    .then( () => this.executeLiveLoad(iliasObject))
                    .catch( (error) =>
                        this.syncEnded()
                            .then( () => {
                                this.events.publish("sync:complete");
                                return Promise.reject(error);
                            })
                    )
                    .then(promise  => {
                        SynchronizationService.state.liveLoading = false;
                        return promise;
                    })
            });
    }

    /**
     * Execute synchronization for all iliasObjects that are favorites and their children
     * @returns Promise<void>
     */
    async loadAllOfflineContent(): Promise<void> {
        await this.loadCurrentUser();
        const favorites: Array<ILIASObject> = await Favorites.findByUserId(this.user.id);
        if(favorites.length === 0) return;
        await this.addObjectsToSyncQueue(favorites);
    }

    /**
     * Add ILIASObjects to the syncOfflineQueue for offline-synchronization and start offline-sync, if it is not already running
     * @param iliasObjects
     */
    async addObjectsToSyncQueue(iliasObjects: ILIASObject|Array<ILIASObject>): Promise<void> {
        await this.loadCurrentUser();
        this.syncOfflineQueue = Array.prototype.concat(this.syncOfflineQueue, iliasObjects);
        this.updateOfflineSyncStatusMessage();
        if(!SynchronizationService.state.loadingOfflineContent)
            await this.processOfflineSyncQueue();
    }

    /**
     * Download all ILIASObjects and their contents in the syncOfflineQueue
     */
    async processOfflineSyncQueue(): Promise<void> {
        if (this.syncOfflineQueue.length === this.syncOfflineQueueCnt) {
            this.syncOfflineQueue = [];
            this.syncOfflineQueueCnt = 0;
            SynchronizationService.state.loadingOfflineContent = false;
            return;
        }

        SynchronizationService.state.loadingOfflineContent = true;
        this.updateOfflineSyncStatusMessage();

        const ilObj: ILIASObject = this.syncOfflineQueue[this.syncOfflineQueueCnt];
        // the user may has unmarked the object in the mean time
        if(ilObj.isFavorite) {
            await ilObj.setIsFavorite(2);
            await this.loadOfflineObjectRecursive(ilObj);
            await ILIASObject.setOfflineAvailableRecursive(ilObj, this.user, true);
            // the user may has unmarked the object in the mean time
            if(ilObj.isFavorite) await ilObj.setIsFavorite(1);
            else ilObj.removeFromFavorites(this.fileService);
        }

        this.syncOfflineQueueCnt++;
        this.footerToolbarOfflineContent.removeJob(Job.FileDownload);
        await this.processOfflineSyncQueue();
    }

    /**
     * Set the status-message of the offline-synchronization
     */
    private updateOfflineSyncStatusMessage(): void {
        const cnt: number = this.syncOfflineQueueCnt + 1;
        const size: number = this.syncOfflineQueue.length;
        const title: string = this.syncOfflineQueue[this.syncOfflineQueueCnt].title;
        const footerMsg: string = `${this.translate.instant("object-list.downloading")} ${cnt}/${size} "${title}"`;

        this.footerToolbarOfflineContent.removeJob(Job.FileDownload);
        this.footerToolbarOfflineContent.addJob(Job.FileDownload, footerMsg);
    }

    /**
     * Execute synchronization for an iliasObject and all its children
     * @param iliasObject
     * @returns Promise<SyncResults>
     */
    async loadOfflineObjectRecursive(iliasObject: ILIASObject): Promise<SyncResults> {
        console.log("method - loadOfflineObjectRecursive");
        await iliasObject.setIsFavorite(2);
        if(SynchronizationService.state.recursiveSyncRunning) {
            let resolver;
            let rejecter;
            const promise: Promise<SyncResults> = new Promise((resolve, reject) => {
                resolver = resolve;
                rejecter = reject;
            });
            this.recursiveSyncQueue.push({
                object: iliasObject,
                resolver: resolver,
                rejecter: rejecter
            });
            return promise;
        }

        return this.downloadContainerContent(iliasObject)
            .then((syncResult) => {
                if(this.recursiveSyncQueue.length > 0) {
                    const sync: SyncEntry = this.recursiveSyncQueue.pop();
                    this.loadOfflineObjectRecursive(sync.object)
                        .then((syncResult: SyncResults) => {
                            sync.resolver(syncResult);
                        }).catch(error => {
                        sync.rejecter(error);
                    });
                }
                return Promise.resolve(syncResult);
            })
            .catch( (error) => {
                return Promise.reject(error);
            });
    }

    private async downloadContainerContent(container: ILIASObject): Promise<SyncResults> {
        const iliasObjects: Array<ILIASObject> = await this.dataProvider.getObjectData(container, this.user, true);
        iliasObjects.push(container);
        const syncResults: SyncResults = await this.checkForFileDownloads(iliasObjects);
        await Promise.all(syncResults.fileDownloads).catch(
            () => console.warn(`Encountered some problem in method 'downloadContainerContent' with container ${container.title}`)
        );
        await this.downloadLearnplaces(iliasObjects).toPromise();
        return syncResults;
    }

    private downloadLearnplaces(tree: Array<ILIASObject>): Observable<void> {
        return Observable.merge(...tree
            .filter(it => it.isLearnplace())
            .map(it => Observable.fromPromise(
                this.learnplaceLoader.load(it.objId).then(() => {
                    it.needsDownload = false;
                })
            ))
        );
    }

    /**
     * Set the user-variable of the object
     */
    private async loadCurrentUser(): Promise<void> {
        this.user = await User.currentUser();
    }

    /**
     * set local recursiveSyncRunning and db entry that a sync is in progress
     */
    protected async syncStarted(): Promise<any> {
        return new Promise((resolve, reject) => {
            SynchronizationService.state.recursiveSyncRunning = true;
            SQLiteDatabaseService.instance().then(db => {
                db.query(`INSERT INTO synchronization (userId, startDate, endDate, recursiveSyncRunning) VALUES (${this.user.id}, date('now'), NULL, 1)`)
                    .then(() => {
                        resolve();
                    }).catch(err => {
                    Log.error(this, err);
                    reject();
                });
            });
        });
    }

    /**
     * set local recursiveSyncRunning and closes the db entry that a sync is in progress
     */
    protected async syncEnded(): Promise<any> {
        SynchronizationService.state.recursiveSyncRunning = false;
        Log.write(this, "ending Sync.");

        return SQLiteDatabaseService.instance()
            .then(db => db.query(
                `UPDATE synchronization SET recursiveSyncRunning = 0, endDate = date('now') WHERE userId = ${this.user.id} AND recursiveSyncRunning = 1`
            ))
            .then(() => this.updateLastSync(this.user.id));
    }

    updateLastSync(userId: number): Promise<any> {
        return SQLiteDatabaseService.instance()
            .then(db =>
              db.query(`SELECT endDate FROM synchronization WHERE userId = ${userId} AND endDate not Null ORDER BY endDate DESC LIMIT 1`))
            .then((result) => {
                if(result.rows.length == 0)
                    return Promise.resolve(null);
                Log.describe(this, "last sync: ", new Date(result.rows.item(0).endDate));
				const now: Date = new Date();
				this.lastSync = new Date(result.rows.item(0).endDate);

				let date_string: string = "";
				if (now.getMonth() == this.lastSync.getMonth() && now.getFullYear() == this.lastSync.getFullYear()) {
					if (now.getDate() == this.lastSync.getDate()) {
						date_string = this.translate.instant("today");
					} else if ((now.getDate() - 1) == this.lastSync.getDate()) {
						date_string = this.translate.instant("yesterday");
					}
				}

				date_string = date_string ? date_string : this.lastSync.getDate()+"."+(this.lastSync.getMonth()+1)+"."+this.lastSync.getFullYear();
                this.lastSyncString = date_string;
                Log.describe(this, "lastdate", this.lastSync);
                return Promise.resolve(this.lastSync);
            });
    }


    /**
     * check if the user still has a running sync in the db.
     */
    hasUnfinishedSync(user: User): Promise<boolean> {
        if(!user)
            return Promise.reject("No user given.");

        return SQLiteDatabaseService.instance()
                .then(db => db.query("SELECT * FROM synchronization WHERE recursiveSyncRunning = 1 AND userId = " + user.id))
                .then(result => Promise.resolve((<any> result).rows.length > 0));
    }

    /**
     * Get all objects marked as offline available by the user
     * @param user
     * @returns {Promise<ILIASObject[]>}
     */
    protected getOfflineAvailableObjects(user: User): Promise<Array<ILIASObject>> {
        const sql = "SELECT * FROM objects WHERE userId = ? AND isOfflineAvailable = 1 AND offlineAvailableOwner = ?";

        return SQLiteDatabaseService.instance()
            .then(db => db.query(sql, [user.id, ILIASObject.OFFLINE_OWNER_USER]))
            .then((response: any) => {
                    const iliasObjectPromises = [];
                    for (let i = 0; i < response.rows.length; i++) {
                        iliasObjectPromises.push(ILIASObject.find(response.rows.item(i).id));
                    }

                    return Promise.all(iliasObjectPromises);
            });
    }

    /**
     * Finds all files that should be downloaded. Also performs checks if these files can be downloaded based
     * on the user's settings
     * @param iliasObjects
     */
    protected checkForFileDownloads(iliasObjects: Array<ILIASObject>): Promise<SyncResults> {
        const fileDownloads: Array<Promise<void>> = [];
        return new Promise((resolve: Resolve<SyncResults>, reject: Reject<Error>) => {
            this.user.settings.then(settings => {
                FileData.getTotalDiskSpace().then(space => {

                    // We split the objects in different categories.
                    const downloads: Array<ILIASObject> = [];
                    const filesTooBig: Array<{ object: ILIASObject, reason: LeftOutReason}> = [];
                    const noMoreSpace: Array<{ object: ILIASObject, reason: LeftOutReason}> = [];
                    const filesAlreadySynced: Array<ILIASObject> = [];

                    // Furthermore we need some infos
                    const availableSpace: number = settings.quotaSize * 1000 * 1000;
                    let currentlyUsedSpace: number = space;

                    // make sure to only sync files.
                    const fileObjects: Array<ILIASObject> = iliasObjects.filter(iliasObject => {
                        return iliasObject.type == "file";
                    });

                    // We sort all objects to know which to download and which to leave out.
                    fileObjects.forEach(fileObject => {
                        if (fileObject.needsDownload) {
                            const fileSize: number = parseInt(fileObject.data.fileSize, 10);
                            if (currentlyUsedSpace + fileSize <= availableSpace) {
                                if (fileSize <= settings.downloadSize * 1000 * 1000) {
                                    downloads.push(fileObject);
                                    currentlyUsedSpace += fileSize;
                                } else {
                                    filesTooBig.push({object: fileObject, reason: LeftOutReason.FileTooBig});
                                }
                            } else {
                                noMoreSpace.push({object: fileObject, reason: LeftOutReason.QuotaExceeded});
                            }
                        } else {
                            filesAlreadySynced.push(fileObject);
                        }
                    });

                    // We make a copy of the files to download, as the list gets decreased in the download process
                    const allDownloads: Array<ILIASObject> = downloads.slice(0); // This is the javascript's clone function....

                    // we execute the file downloads
                    const executeDownloads: Array<Promise<any>> = this.executeFileDownloads(downloads);
                    for(let i: number = 0; i < downloads.length; i++) {
                        fileDownloads.push(new Promise((resolve: Resolve<void>, reject: Reject<Error>) => {
                            executeDownloads[i].then(() => {
                                resolve();
                            }).catch(error => {
                                Log.describe(this, "Execute File Download rejected", error);
                                reject(error);
                            });
                        }));
                    }

                    resolve(new SyncResults(
                        fileObjects,
                        allDownloads,
                        filesAlreadySynced,
                        filesTooBig.concat(noMoreSpace),
                        fileDownloads
                    ));

                }).catch(error => {
                    return Promise.reject(error);
                });
            }).catch(error => {
                return Promise.reject(error);
            });
        });
    }

    /**
     * Downloads one file after another
     */
    protected executeFileDownloads(downloads: Array<ILIASObject>): Array<Promise<any>> {
        const results: Array<Promise<any>> = [];
        for(const download of downloads) {
            results.push(new Promise((resolve, reject) => {
                this.fileService.download(download).then(() => {
                    resolve();
                }).catch(error => {
                    reject(error);
                })
            }))
        }
        return results;
    }

    async executeNewsSync(): Promise<void> {
        await this.loadCurrentUser();
        await this.newsSynchronization.synchronize();
        await this.visitJournalSynchronization.synchronize();
        await this.syncEnded();
    }

    private async executeLiveLoad(parent: ILIASObject): Promise<Array<ILIASObject>> {
        const iliasObjects: Promise<Array<ILIASObject>> = (parent === undefined)?
            this.dataProvider.getDesktopData(this.user):
            this.dataProvider.getObjectData(parent, this.user, false);

        return iliasObjects
            .then(() => this.syncEnded())
            .then( () => Promise.resolve(iliasObjects))
            .catch(await this.syncEnded());
    }
}

export class SyncResults {
    constructor(public totalObjects: Array<ILIASObject>,
                public objectsDownloaded: Array<ILIASObject>,
                public objectsUnchanged: Array<ILIASObject>,
                public objectsLeftOut: Array<{object: ILIASObject, reason: LeftOutReason}>,
                public fileDownloads: Array<Promise<void>>) {
    }
}

/**
 * WARNING at the moment we only use FileTooBig, the other two reasons lead to an abortion of the sync!
 */
export enum LeftOutReason {
    // In most cases you don't want to download files if you're not in the wlan.
    NoWLAN = 1,
    // In the settings you can specify how big files should be you want to download.
    FileTooBig = 2,
    // In the settings you can set a max quota.
    QuotaExceeded = 3
}
