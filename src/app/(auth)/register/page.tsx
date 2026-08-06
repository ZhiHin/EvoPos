import type { Metadata } from 'next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { RegisterForm } from '@/modules/auth/ui/register-form'

export const metadata: Metadata = { title: 'Create your account' }

export default function RegisterPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your restaurant</CardTitle>
        <CardDescription>
          Sets up your account and your first restaurant. You can add branches
          and staff afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm />
      </CardContent>
    </Card>
  )
}
