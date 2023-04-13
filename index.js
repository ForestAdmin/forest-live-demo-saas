require('dotenv').config();
const { createAgent } = require('@forestadmin/agent');
const { createSqlDataSource } = require('@forestadmin/datasource-sql');

const dialectOptions = {};

if (process.env.DATABASE_SSL && JSON.parse(process.env.DATABASE_SSL.toLowerCase())) {
  // Set to false to bypass SSL certificate verification (useful for self-signed certificates).
  const rejectUnauthorized =
    process.env.DATABASE_REJECT_UNAUTHORIZED &&
    JSON.parse(process.env.DATABASE_REJECT_UNAUTHORIZED.toLowerCase());
  dialectOptions.ssl = !rejectUnauthorized
    ? {
        require: true,
        rejectUnauthorized,
      }
    : true;
}

// Create the Forest Admin agent.
/**
 * @type {import('@forestadmin/agent').Agent<import('./typings').Schema>}
 */
const agent = createAgent({
  authSecret: process.env.FOREST_AUTH_SECRET,
  envSecret: process.env.FOREST_ENV_SECRET,
  isProduction: process.env.NODE_ENV === 'production',
  // Autocompletion of collection names and fields
  typingsPath: './typings.ts',
  typingsMaxDepth: 5,
})
  // Connect your datasources.
  .addDataSource(
    createSqlDataSource({
      uri: process.env.DATABASE_URL,
      schema: process.env.DATABASE_SCHEMA,
      dialectOptions,
    }),
  );

agent.customizeCollection('users', collection => {
  collection.addField('Fullname', {
    columnType: 'String',
    dependencies: ['firstname', 'lastname'],
    getValues: (records, context) => records.map(r => `${r.firstname} ${r.lastname}`),
  })
  .emulateFieldFiltering('Fullname')
  .emulateFieldSorting('Fullname')

  /****** USERS ACTIONS ********/

  .addAction('Disable user', {
    scope: 'Single',
    execute: async (context, resultBuilder) => {
      return resultBuilder.success('User disabled!');
    },
  });
});

agent.customizeCollection('companies', collection => {
  collection.addField('planId', {
    columnType: 'Number',
    dependencies: ['id'],
    getValues: async (records, context) => {
      const recordIds = records.map(r => r.id);
      const filter = { conditionTree: { field: 'company_id', operator: 'In', value: recordIds } };
      const rows = await context.dataSource.getCollection('subscriptions').list(filter, ['company_id', 'plan_id']);

      return records.map(record => {
        const row = rows.find(r => r.company_id === record.id);
        return row.plan_id;
      });
    },
  })
  .replaceFieldOperator('planId', 'In', async (planId, context) => {
    const records = await context.dataSource
      .getCollection('plans')
      .list({ conditionTree: { field: 'id', operator: 'In', value: planId } }, ['id']);

    return { field: 'id', operator: 'In', value: records.map(r => r.id) };
  })
  .addManyToOneRelation('currentPlan', 'plans', {
    foreignKey: 'planId',
  })
  .addField('nbUsers', {
    columnType: 'Number',
    dependencies: ['id'],
    getValues: async (records, context) => {
      const recordIds = records.map(r => r.id);

      const filter = { conditionTree: { field: 'company_id', operator: 'In', value: recordIds } };
      const aggregation = { operation: 'Count', field: 'id', groups: [{ field: 'company_id' }] };
      const rows = await context.dataSource.getCollection('users').aggregate(filter, aggregation);

      return records.map(record => {
        const row = rows.find(r => r.group.company_id === record.id);
        return row?.value ?? 0;
      });
    },
  })
  .emulateFieldFiltering('nbUsers')
  .emulateFieldSorting('nbUsers')
  .addField('planPrice', {
    columnType: 'Number',
    dependencies: ['planId'],
    getValues: async (records, context) => {
      const recordIds = records.map(r => r.planId);
      const filter = { conditionTree: { field: 'id', operator: 'In', value: recordIds } };
      const rows = await context.dataSource.getCollection('plans').list(filter, ['id', 'price']);

      return records.map(record => {
        const row = rows.find(r => r.id === record.planId);
        return row.price;
      });
    },
  })
  .addField('MRR', {
    columnType: 'Number',
    dependencies: ['planPrice', 'nbUsers'],
    getValues: (records) => records.map(r => {
      return r.planPrice * r.nbUsers;
    })
  })
  .emulateFieldFiltering('MRR')
  .emulateFieldSorting('MRR')

  /****** COMPANIES ACTIONS ********/
  
  .addAction('Change plan', {
    scope: 'Single',
    form: [
      {
        label: 'Plan',
        type: 'Collection',
        collectionName: 'plans',
        isRequired: true,
        enumValues: async context => {

          const plans = await context.getRecord(['name']);
          const base = [`${plans.name}`];
          return base;
        }
      },
    ],
    execute: async (context, resultBuilder) => {
      return resultBuilder.success('Plan updated!');
    },
  })
  .addAction('Cancel subscription', {
    scope: 'Single',
    form: [
      {
        label: 'Are you sure?',
        description: 'Think twice before cancelling this subscription.',
        type: 'Enum',
        isRequired: true,
        enumValues: ['⛔️ No', '✅ Yes'], 
        defaultValue: '⛔️ No',
      },
    ],
    execute: async (context, resultBuilder) => {
      return resultBuilder.success('Subscription cancelled!');
    },
  })
});


agent
  // Expose an HTTP endpoint.
  .mountOnStandaloneServer(process.env.PORT || process.env.APPLICATION_PORT)
  // Start the agent.
  .start();
