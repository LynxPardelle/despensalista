import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import * as Joi from 'joi';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiMetricsService } from './application/services/api-metrics.service';
import { ApiMetricsAlertSinkService } from './application/services/api-metrics-alert-sink.service';
import {
  COGNITO_AUTH_URL_BUILDER,
  COGNITO_TOKEN_CLIENT,
  COGNITO_TOKEN_VERIFIER,
  COGNITO_USER_ADMIN,
  INVENTORY_LOT_DAO,
  INVENTORY_LOT_REPOSITORY,
  PANTRY_MUTATION_PORT,
  HOUSEHOLD_REPOSITORY,
  PRODUCT_DAO,
  PRODUCT_REPOSITORY,
  PRODUCT_TYPE_DAO,
  PRODUCT_TYPE_REPOSITORY,
  SCHEDULING_SERVICE,
  SHOPPING_SHARE_REPOSITORY,
  SHOPPING_LIST_REPOSITORY,
  USER_DAO,
  USER_DEVICE_REPOSITORY,
  USER_PREFERENCES_DAO,
  WASTE_EVENT_REPOSITORY,
} from './application/tokens';
import { CognitoAuthTransactionService } from './application/services/cognito-auth-transaction.service';
import { CognitoProfileSyncService } from './application/services/cognito-profile-sync.service';
import { ArchiveInventoryLotUseCase } from './application/use-cases/archive-inventory-lot.use-case';
import { ArchiveProductTypeUseCase } from './application/use-cases/archive-product-type.use-case';
import { CloseShoppingPurchaseUseCase } from './application/use-cases/close-shopping-purchase.use-case';
import { ConsumeInventoryLotUseCase } from './application/use-cases/consume-inventory-lot.use-case';
import { CreateInventoryLotUseCase } from './application/use-cases/create-inventory-lot.use-case';
import { CreateProductUseCase } from './application/use-cases/create-product.use-case';
import { CreateProductTypeUseCase } from './application/use-cases/create-product-type.use-case';
import {
  CreateShoppingShareUseCase,
  ListActiveShoppingSharesUseCase,
  ResolveShoppingShareUseCase,
  RevokeShoppingShareByIdUseCase,
  RevokeShoppingShareUseCase,
} from './application/use-cases/shopping-share.use-cases';
import {
  CreateShoppingListUseCase,
  DeleteShoppingListUseCase,
  ListShoppingListsUseCase,
} from './application/use-cases/shopping-list.use-cases';
import { DeleteInventoryLotUseCase } from './application/use-cases/delete-inventory-lot.use-case';
import { DeleteAccountUseCase } from './application/use-cases/delete-account.use-case';
import { ResumeAccountDeletionsUseCase } from './application/use-cases/resume-account-deletions.use-case';
import { DeletePantryDataUseCase } from './application/use-cases/delete-pantry-data.use-case';
import { DeleteProductTypeUseCase } from './application/use-cases/delete-product-type.use-case';
import { GetArchivedPantryItemsUseCase } from './application/use-cases/get-archived-pantry-items.use-case';
import {
  AcceptHouseholdInviteUseCase,
  CreateHouseholdInviteUseCase,
  GetHouseholdWorkspaceUseCase,
  RecordHouseholdActivityUseCase,
  RemoveHouseholdMemberUseCase,
  ResolveHouseholdPantryAccessUseCase,
  RevokeHouseholdInviteUseCase,
} from './application/use-cases/household.use-cases';
import { GetExpiringLotsUseCase } from './application/use-cases/get-expiring-lots.use-case';
import { GetCurrentUserUseCase } from './application/use-cases/get-current-user.use-case';
import { GetProductByIdUseCase } from './application/use-cases/get-product-by-id.use-case';
import { GetProductTypeByIdUseCase } from './application/use-cases/get-product-type-by-id.use-case';
import { GetProductsByUserUseCase } from './application/use-cases/get-products-by-user.use-case';
import { GetPantryOverviewUseCase } from './application/use-cases/get-pantry-overview.use-case';
import { GetUserProfileUseCase } from './application/use-cases/get-user-profile.use-case';
import { GetWasteOverviewUseCase } from './application/use-cases/get-waste-overview.use-case';
import { ListInventoryLotsUseCase } from './application/use-cases/list-inventory-lots.use-case';
import { RestoreInventoryLotUseCase } from './application/use-cases/restore-inventory-lot.use-case';
import { RestoreProductTypeUseCase } from './application/use-cases/restore-product-type.use-case';
import { SearchProductTypesUseCase } from './application/use-cases/search-product-types.use-case';
import { SignOutAllSessionsUseCase } from './application/use-cases/sign-out-all-sessions.use-case';
import { UpdateProductTypePlanningSettingsUseCase } from './application/use-cases/update-product-type-planning-settings.use-case';
import { UpdateProductTypeShoppingMetadataUseCase } from './application/use-cases/update-product-type-shopping-metadata.use-case';
import { UpdateUserPreferencesUseCase } from './application/use-cases/update-user-preferences.use-case';
import { UpdateProductTypeDepletionRuleUseCase } from './application/use-cases/update-product-type-depletion-rule.use-case';
import { UpdateProductQuantityUseCase } from './application/use-cases/update-product-quantity.use-case';
import { SchedulingDomainService } from './domain/services/scheduling.service';
import { CognitoAuthUrlBuilderService } from './infrastructure/auth/cognito/cognito-auth-url-builder.service';
import { CognitoTokenClientService } from './infrastructure/auth/cognito/cognito-token-client.service';
import { CognitoTokenVerifierService } from './infrastructure/auth/cognito/cognito-token-verifier.service';
import { CognitoUserAdminService } from './infrastructure/auth/cognito/cognito-user-admin.service';
import { DynamoDbDocumentClientService } from './infrastructure/database/dynamodb/dynamodb-document-client.service';
import { DynamoDbPantryMutationAdapter } from './infrastructure/database/dynamodb/dynamodb-pantry-mutation.adapter';
import { MongoPantryMutationAdapter } from './infrastructure/database/mongodb/mongodb-pantry-mutation.adapter';
import { DynamoDbInventoryLotRepository } from './infrastructure/database/dynamodb/dynamodb-inventory-lot.repository';
import { DynamoDbHouseholdRepository } from './infrastructure/database/dynamodb/dynamodb-household.repository';
import { DynamoDbProductRepository } from './infrastructure/database/dynamodb/dynamodb-product.repository';
import { DynamoDbProductTypeRepository } from './infrastructure/database/dynamodb/dynamodb-product-type.repository';
import { DynamoDbShoppingShareRepository } from './infrastructure/database/dynamodb/dynamodb-shopping-share.repository';
import { DynamoDbShoppingListRepository } from './infrastructure/database/dynamodb/dynamodb-shopping-list.repository';
import { DynamoDbUserDao } from './infrastructure/database/dynamodb/dynamodb-user.dao';
import { DynamoDbUserDeviceRepository } from './infrastructure/database/dynamodb/dynamodb-user-device.repository';
import { DynamoDbUserPreferencesDao } from './infrastructure/database/dynamodb/dynamodb-user-preferences.dao';
import { DynamoDbWasteEventRepository } from './infrastructure/database/dynamodb/dynamodb-waste-event.repository';
import { MongoInventoryLotRepository } from './infrastructure/database/mongodb/mongodb-inventory-lot.repository';
import { MongoHouseholdRepository } from './infrastructure/database/mongodb/mongodb-household.repository';
import { MongoProductRepository } from './infrastructure/database/mongodb/mongodb-product.repository';
import { MongoProductTypeRepository } from './infrastructure/database/mongodb/mongodb-product-type.repository';
import { MongoShoppingShareRepository } from './infrastructure/database/mongodb/mongodb-shopping-share.repository';
import { MongoShoppingListRepository } from './infrastructure/database/mongodb/mongodb-shopping-list.repository';
import { MongoUserDao } from './infrastructure/database/mongodb/mongodb-user.dao';
import { MongoUserDeviceRepository } from './infrastructure/database/mongodb/mongodb-user-device.repository';
import { MongoUserPreferencesDao } from './infrastructure/database/mongodb/mongodb-user-preferences.dao';
import { MongoWasteEventRepository } from './infrastructure/database/mongodb/mongodb-waste-event.repository';
import {
  InventoryLotDocument,
  InventoryLotSchema,
} from './infrastructure/database/mongodb/schemas/inventory-lot.schema';
import {
  HouseholdDocument,
  HouseholdSchema,
} from './infrastructure/database/mongodb/schemas/household.schema';
import {
  ProductDocument,
  ProductSchema,
} from './infrastructure/database/mongodb/schemas/product.schema';
import {
  ProductTypeDocument,
  ProductTypeSchema,
} from './infrastructure/database/mongodb/schemas/product-type.schema';
import {
  UserDocument,
  UserSchema,
} from './infrastructure/database/mongodb/schemas/user.schema';
import {
  UserDeviceDocument,
  UserDeviceSchema,
} from './infrastructure/database/mongodb/schemas/user-device.schema';
import {
  WasteEventDocument,
  WasteEventSchema,
} from './infrastructure/database/mongodb/schemas/waste-event.schema';
import {
  ShoppingShareDocument,
  ShoppingShareSchema,
} from './infrastructure/database/mongodb/schemas/shopping-share.schema';
import {
  ShoppingListDocument,
  ShoppingListSchema,
} from './infrastructure/database/mongodb/schemas/shopping-list.schema';
import { AuthCookieService } from './infrastructure/http/auth/auth-cookie.service';
import { AuthStepUpService } from './infrastructure/http/auth/auth-step-up.service';
import { AccessTokenGuard } from './infrastructure/http/auth/access-token.guard';
import { AuthController } from './infrastructure/http/controllers/auth.controller';
import { HouseholdController } from './infrastructure/http/controllers/household.controller';
import { InventoryLotsController } from './infrastructure/http/controllers/inventory-lots.controller';
import { PantryController } from './infrastructure/http/controllers/pantry.controller';
import { ProfileController } from './infrastructure/http/controllers/profile.controller';
import { ProductTypesController } from './infrastructure/http/controllers/product-types.controller';
import { ProductsController } from './infrastructure/http/controllers/products.controller';
import { ShoppingSharesController } from './infrastructure/http/controllers/shopping-shares.controller';

const buildMongoUri = (configService: ConfigService): string => {
  const host = configService.get<string>('MONGO_HOST') ?? '127.0.0.1';
  const port = configService.get<string>('MONGO_PORT') ?? '27017';
  const username = configService.get<string>('MONGO_APP_USERNAME');
  const password = configService.get<string>('MONGO_APP_PASSWORD');
  const databaseName =
    configService.get<string>('MONGO_APP_DATABASE') ??
    configService.get<string>('DATABASE_NAME') ??
    'despensalista';
  const explicitDatabaseUrl = configService.get<string>('DATABASE_URL');

  if (configService.get<string>('MONGO_HOST')) {
    if (username && password) {
      return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${databaseName}?authSource=${encodeURIComponent(databaseName)}`;
    }

    return `mongodb://${host}:${port}/${databaseName}`;
  }

  if (explicitDatabaseUrl) {
    return explicitDatabaseUrl;
  }

  if (username && password) {
    return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${databaseName}?authSource=${encodeURIComponent(databaseName)}`;
  }

  return `mongodb://${host}:${port}/${databaseName}`;
};

const persistenceProvider = (
  process.env.PERSISTENCE_PROVIDER ?? 'mongodb'
).toLowerCase();
const useDynamoDb = persistenceProvider === 'dynamodb';
const databaseImports = useDynamoDb
  ? []
  : [
      MongooseModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          uri: buildMongoUri(configService),
          dbName:
            configService.get<string>('MONGO_APP_DATABASE') ??
            configService.get<string>('DATABASE_NAME') ??
            'despensalista',
        }),
      }),
      MongooseModule.forFeature([
        { name: ProductDocument.name, schema: ProductSchema },
        { name: ProductTypeDocument.name, schema: ProductTypeSchema },
        { name: InventoryLotDocument.name, schema: InventoryLotSchema },
        { name: HouseholdDocument.name, schema: HouseholdSchema },
        { name: UserDocument.name, schema: UserSchema },
        { name: UserDeviceDocument.name, schema: UserDeviceSchema },
        { name: WasteEventDocument.name, schema: WasteEventSchema },
        { name: ShoppingShareDocument.name, schema: ShoppingShareSchema },
        { name: ShoppingListDocument.name, schema: ShoppingListSchema },
      ]),
    ];
const databaseClassProviders = useDynamoDb
  ? [
      DynamoDbDocumentClientService,
      DynamoDbPantryMutationAdapter,
      DynamoDbUserDao,
      DynamoDbUserPreferencesDao,
      DynamoDbHouseholdRepository,
      DynamoDbProductRepository,
      DynamoDbProductTypeRepository,
      DynamoDbInventoryLotRepository,
      DynamoDbShoppingShareRepository,
      DynamoDbShoppingListRepository,
      DynamoDbUserDeviceRepository,
      DynamoDbWasteEventRepository,
    ]
  : [
      MongoUserDao,
      MongoPantryMutationAdapter,
      MongoUserPreferencesDao,
      MongoHouseholdRepository,
      MongoProductRepository,
      MongoProductTypeRepository,
      MongoInventoryLotRepository,
      MongoShoppingShareRepository,
      MongoShoppingListRepository,
      MongoUserDeviceRepository,
      MongoWasteEventRepository,
    ];
const userDaoProvider = useDynamoDb ? DynamoDbUserDao : MongoUserDao;
const userPreferencesDaoProvider = useDynamoDb
  ? DynamoDbUserPreferencesDao
  : MongoUserPreferencesDao;
const productRepositoryProvider = useDynamoDb
  ? DynamoDbProductRepository
  : MongoProductRepository;
const productTypeRepositoryProvider = useDynamoDb
  ? DynamoDbProductTypeRepository
  : MongoProductTypeRepository;
const inventoryLotRepositoryProvider = useDynamoDb
  ? DynamoDbInventoryLotRepository
  : MongoInventoryLotRepository;
const householdRepositoryProvider = useDynamoDb
  ? DynamoDbHouseholdRepository
  : MongoHouseholdRepository;
const shoppingShareRepositoryProvider = useDynamoDb
  ? DynamoDbShoppingShareRepository
  : MongoShoppingShareRepository;
const shoppingListRepositoryProvider = useDynamoDb
  ? DynamoDbShoppingListRepository
  : MongoShoppingListRepository;
const userDeviceRepositoryProvider = useDynamoDb
  ? DynamoDbUserDeviceRepository
  : MongoUserDeviceRepository;
const wasteEventRepositoryProvider = useDynamoDb
  ? DynamoDbWasteEventRepository
  : MongoWasteEventRepository;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'production')
          .default('development'),
        PORT: Joi.number().port().default(3000),
        PERSISTENCE_PROVIDER: Joi.string()
          .valid('mongodb', 'dynamodb')
          .default('mongodb'),
        DATABASE_URL: Joi.string()
          .uri({ scheme: ['mongodb', 'mongodb+srv'] })
          .optional(),
        DATABASE_NAME: Joi.string().default('despensalista'),
        MONGO_HOST: Joi.string().hostname().optional(),
        MONGO_PORT: Joi.number().port().optional(),
        MONGO_APP_DATABASE: Joi.string().optional(),
        MONGO_APP_USERNAME: Joi.string().optional(),
        MONGO_APP_PASSWORD: Joi.string().optional(),
        DYNAMODB_REGION: Joi.string().optional(),
        DYNAMODB_ENDPOINT: Joi.string().uri().optional(),
        DYNAMODB_USERS_TABLE: Joi.when('PERSISTENCE_PROVIDER', {
          is: 'dynamodb',
          then: Joi.string().required(),
          otherwise: Joi.string().optional(),
        }),
        DYNAMODB_PRODUCTS_TABLE: Joi.when('PERSISTENCE_PROVIDER', {
          is: 'dynamodb',
          then: Joi.string().required(),
          otherwise: Joi.string().optional(),
        }),
        DYNAMODB_PRODUCT_TYPES_TABLE: Joi.when('PERSISTENCE_PROVIDER', {
          is: 'dynamodb',
          then: Joi.string().required(),
          otherwise: Joi.string().optional(),
        }),
        DYNAMODB_INVENTORY_LOTS_TABLE: Joi.when('PERSISTENCE_PROVIDER', {
          is: 'dynamodb',
          then: Joi.string().required(),
          otherwise: Joi.string().optional(),
        }),
        API_PREFIX: Joi.string().default('api'),
        ORIGIN_VERIFY_HEADER_NAME: Joi.string()
          .pattern(/^[a-z0-9-]+$/)
          .optional(),
        ORIGIN_VERIFY_HEADER_VALUE: Joi.string().min(16).optional(),
        CORS_ORIGIN: Joi.string().default('http://localhost:4200'),
        HELMET_ENABLED: Joi.string().valid('true', 'false').default('true'),
        RATE_LIMIT_ENABLED: Joi.string().valid('true', 'false').default('true'),
        RATE_LIMIT_MAX: Joi.number().integer().positive().default(120),
        RATE_LIMIT_TIME_WINDOW: Joi.alternatives()
          .try(Joi.string().min(1), Joi.number().integer().positive())
          .default('1 minute'),
        RATE_LIMIT_TRUST_PROXY: Joi.string()
          .valid('true', 'false')
          .default('false'),
        METRICS_SLOW_REQUEST_THRESHOLD_MS: Joi.number()
          .integer()
          .positive()
          .default(1000),
        METRICS_ERROR_RATE_ALERT_THRESHOLD: Joi.number()
          .min(0)
          .max(1)
          .default(0.05),
        METRICS_MAX_ROUTES: Joi.number().integer().positive().default(50),
        METRICS_ACCESS_TOKEN: Joi.string().allow('').optional(),
        METRICS_ALERT_WEBHOOK_URL: Joi.string()
          .uri({ scheme: ['http', 'https'] })
          .allow('')
          .optional(),
        METRICS_ALERT_MIN_INTERVAL_SECONDS: Joi.number()
          .integer()
          .positive()
          .default(300),
        AUTH_ACCESS_COOKIE_TTL_SECONDS: Joi.number()
          .integer()
          .positive()
          .default(900),
        AUTH_REFRESH_COOKIE_TTL_SECONDS: Joi.number()
          .integer()
          .positive()
          .default(2592000),
        AUTH_STEP_UP_ENABLED: Joi.string()
          .valid('true', 'false')
          .default('false'),
        AUTH_STEP_UP_MAX_AGE_SECONDS: Joi.number()
          .integer()
          .positive()
          .default(900),
        ARCHIVED_RECORD_RETENTION_DAYS: Joi.number()
          .integer()
          .positive()
          .default(365),
        ARCHIVED_RECORD_AUTO_DELETE_ENABLED: Joi.string()
          .valid('false')
          .default('false'),
        TEMPORARY_SHOPPING_SHARE_RETENTION_DAYS: Joi.number()
          .integer()
          .positive()
          .default(7),
        COGNITO_ENABLED: Joi.string().valid('true', 'false').default('false'),
        COGNITO_ISSUER: Joi.when('COGNITO_ENABLED', {
          is: 'true',
          then: Joi.string()
            .uri({ scheme: ['https'] })
            .required(),
          otherwise: Joi.string()
            .uri({ scheme: ['https'] })
            .allow('')
            .optional(),
        }),
        COGNITO_DOMAIN: Joi.when('COGNITO_ENABLED', {
          is: 'true',
          then: Joi.string()
            .uri({ scheme: ['https'] })
            .required(),
          otherwise: Joi.string()
            .uri({ scheme: ['https'] })
            .allow('')
            .optional(),
        }),
        COGNITO_CLIENT_ID: Joi.when('COGNITO_ENABLED', {
          is: 'true',
          then: Joi.string().required(),
          otherwise: Joi.string().allow('').optional(),
        }),
        COGNITO_USER_POOL_ID: Joi.string().allow('').optional(),
        COGNITO_REGION: Joi.string().allow('').optional(),
        COGNITO_CLIENT_SECRET: Joi.string().allow('').optional(),
        COGNITO_REDIRECT_URI: Joi.when('COGNITO_ENABLED', {
          is: 'true',
          then: Joi.string()
            .uri({ scheme: ['http', 'https'] })
            .required(),
          otherwise: Joi.string()
            .uri({ scheme: ['http', 'https'] })
            .allow('')
            .optional(),
        }),
        COGNITO_LOGOUT_REDIRECT_URI: Joi.when('COGNITO_ENABLED', {
          is: 'true',
          then: Joi.string()
            .uri({ scheme: ['http', 'https'] })
            .required(),
          otherwise: Joi.string()
            .uri({ scheme: ['http', 'https'] })
            .allow('')
            .optional(),
        }),
        COGNITO_SCOPES: Joi.string().default('openid email profile'),
        COGNITO_ALLOWED_PROVIDERS: Joi.string().default(
          'Google,Facebook,COGNITO',
        ),
        COGNITO_AUTH_TRANSACTION_TTL_SECONDS: Joi.number()
          .integer()
          .positive()
          .default(900),
        AUTH_COOKIE_SECURE: Joi.string().valid('true', 'false').optional(),
        AUTH_COOKIE_SAME_SITE: Joi.string()
          .valid('lax', 'strict', 'none')
          .default('lax'),
        AUTH_COOKIE_DOMAIN: Joi.string().allow('').optional(),
        SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
        SWAGGER_TITLE: Joi.string().default('Despensa Lista API'),
        SWAGGER_DESCRIPTION: Joi.string().default(
          'API for managing household products and shopping schedules',
        ),
        SWAGGER_VERSION: Joi.string().default('1.0'),
      }),
    }),
    ...databaseImports,
  ],
  controllers: [
    AppController,
    AuthController,
    HouseholdController,
    ProductsController,
    ProductTypesController,
    InventoryLotsController,
    PantryController,
    ProfileController,
    ShoppingSharesController,
  ],
  providers: [
    AppService,
    ApiMetricsService,
    ApiMetricsAlertSinkService,
    AuthCookieService,
    AuthStepUpService,
    AccessTokenGuard,
    CognitoAuthTransactionService,
    CognitoProfileSyncService,
    CognitoAuthUrlBuilderService,
    CognitoTokenClientService,
    CognitoTokenVerifierService,
    CognitoUserAdminService,
    GetCurrentUserUseCase,
    GetHouseholdWorkspaceUseCase,
    RecordHouseholdActivityUseCase,
    CreateHouseholdInviteUseCase,
    AcceptHouseholdInviteUseCase,
    RevokeHouseholdInviteUseCase,
    RemoveHouseholdMemberUseCase,
    ResolveHouseholdPantryAccessUseCase,
    CloseShoppingPurchaseUseCase,
    CreateProductUseCase,
    CreateProductTypeUseCase,
    CreateShoppingShareUseCase,
    CreateShoppingListUseCase,
    CreateInventoryLotUseCase,
    ConsumeInventoryLotUseCase,
    GetProductByIdUseCase,
    GetProductsByUserUseCase,
    GetProductTypeByIdUseCase,
    GetPantryOverviewUseCase,
    GetArchivedPantryItemsUseCase,
    GetUserProfileUseCase,
    GetWasteOverviewUseCase,
    GetExpiringLotsUseCase,
    ListInventoryLotsUseCase,
    SearchProductTypesUseCase,
    UpdateProductTypeDepletionRuleUseCase,
    UpdateProductTypePlanningSettingsUseCase,
    UpdateProductTypeShoppingMetadataUseCase,
    ArchiveProductTypeUseCase,
    RestoreProductTypeUseCase,
    DeleteProductTypeUseCase,
    DeletePantryDataUseCase,
    DeleteAccountUseCase,
    ResumeAccountDeletionsUseCase,
    SignOutAllSessionsUseCase,
    ArchiveInventoryLotUseCase,
    RestoreInventoryLotUseCase,
    DeleteInventoryLotUseCase,
    UpdateProductQuantityUseCase,
    UpdateUserPreferencesUseCase,
    ListActiveShoppingSharesUseCase,
    ListShoppingListsUseCase,
    ResolveShoppingShareUseCase,
    RevokeShoppingShareByIdUseCase,
    RevokeShoppingShareUseCase,
    DeleteShoppingListUseCase,
    ...databaseClassProviders,
    {
      provide: PANTRY_MUTATION_PORT,
      useExisting: useDynamoDb
        ? DynamoDbPantryMutationAdapter
        : MongoPantryMutationAdapter,
    },
    {
      provide: USER_DAO,
      useExisting: userDaoProvider,
    },
    {
      provide: USER_PREFERENCES_DAO,
      useExisting: userPreferencesDaoProvider,
    },
    {
      provide: PRODUCT_REPOSITORY,
      useExisting: productRepositoryProvider,
    },
    {
      provide: PRODUCT_DAO,
      useExisting: productRepositoryProvider,
    },
    {
      provide: PRODUCT_TYPE_REPOSITORY,
      useExisting: productTypeRepositoryProvider,
    },
    {
      provide: PRODUCT_TYPE_DAO,
      useExisting: productTypeRepositoryProvider,
    },
    {
      provide: INVENTORY_LOT_REPOSITORY,
      useExisting: inventoryLotRepositoryProvider,
    },
    {
      provide: INVENTORY_LOT_DAO,
      useExisting: inventoryLotRepositoryProvider,
    },
    {
      provide: HOUSEHOLD_REPOSITORY,
      useExisting: householdRepositoryProvider,
    },
    {
      provide: SHOPPING_SHARE_REPOSITORY,
      useExisting: shoppingShareRepositoryProvider,
    },
    {
      provide: SHOPPING_LIST_REPOSITORY,
      useExisting: shoppingListRepositoryProvider,
    },
    {
      provide: USER_DEVICE_REPOSITORY,
      useExisting: userDeviceRepositoryProvider,
    },
    {
      provide: WASTE_EVENT_REPOSITORY,
      useExisting: wasteEventRepositoryProvider,
    },
    {
      provide: SCHEDULING_SERVICE,
      useClass: SchedulingDomainService,
    },
    {
      provide: COGNITO_AUTH_URL_BUILDER,
      useExisting: CognitoAuthUrlBuilderService,
    },
    {
      provide: COGNITO_TOKEN_CLIENT,
      useExisting: CognitoTokenClientService,
    },
    {
      provide: COGNITO_TOKEN_VERIFIER,
      useExisting: CognitoTokenVerifierService,
    },
    {
      provide: COGNITO_USER_ADMIN,
      useExisting: CognitoUserAdminService,
    },
  ],
})
export class AppModule {}
